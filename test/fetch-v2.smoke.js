// fetch_page 2차 개선 스모크테스트(2026-11-07) — HTML 파서·표·기사 본문·내장 데이터·iframe·오피스 첨부. 실행: node test/fetch-v2.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.TAVILY_API_KEY = "x";
const JSZip = require("jszip");
const usage = require("../lib/usage");
usage.configured = () => false;
let paidCalls = 0;
const pages = {};
global.fetch = async (u) => {
  u = String(u);
  if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
  if (u.includes("nimbleway") || u.includes("tavily")) { paidCalls++; return new Response("{}", { status: 500 }); }
  const p = pages[u.replace(/^https:\/\/smoke\.example\.com/, "")];
  if (!p) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  return new Response(p.body, { status: 200, headers: p.headers || { "content-type": "text/html; charset=utf-8" } });
};
// 주소 안전 확인(DNS)을 통과시키기 위해 공용 IP로 해석되게 한다
require("dns").promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const web = require("../lib/web");
const html = require("../lib/html");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
const read = (path, extra) => web.call("fetch_page", Object.assign({ url: "https://smoke.example.com" + path, direct_only: true, max_chars: 60000 }, extra || {}), "koo");
const para = "본문 문장입니다. 이 문장은 충분히 길게 반복됩니다. ".repeat(20);

(async () => {
  // 1) DOCTYPE 앞 공백·조건부 주석 — body가 비지 않아야
  pages["/cond"] = { body: `  \n\n<!DOCTYPE HTML>\n<!--[if lt IE 7]><html class="ie"><![endif]-->\n<!--[if gt IE 8]><!--><html lang="ko"><!--<![endif]-->\n<head><title>조건부</title></head><body><div id="contents"><p>${para}</p></div></body></html>` };
  let r = await read("/cond");
  ok(!r.isError && r.structuredContent.text.includes("본문 문장입니다"), "DOCTYPE 앞 공백·조건부 주석 페이지의 본문을 읽음");

  // 2) 속성 안의 '>'가 본문에 새지 않음
  pages["/attr"] = { body: `<html><body><main><span data-mw='{"x":"> $20 trillion <ref>잡음</ref>"}'></span><p>${para}</p></main></body></html>` };
  r = await read("/attr");
  ok(!r.isError && !r.structuredContent.text.includes("잡음") && !r.structuredContent.text.includes("data-mw"), "속성 값 안의 '>'·태그 문자열이 본문에 섞이지 않음");

  // 3) 표: colspan·rowspan을 살린 마크다운 표, 원본 줄바꿈 무시
  pages["/table"] = { body: `<html><body><main><p>${para}</p><table><caption>기준금리</caption><tr><th colspan="2">변경일자</th><th>금리</th></tr>
<tr><td rowspan="2">2026</td><td>
08월 27일</td><td>3.00</td></tr><tr><td>07월 16일</td><td>2.75</td></tr></table></main></body></html>` };
  r = await read("/table");
  const tt = r.structuredContent.text;
  ok(/\| 변경일자 \|\s*\| 금리 \|/.test(tt) && /\| --- \| --- \| --- \|/.test(tt) && tt.includes("| 2026 | 08월 27일 | 3.00 |") && /\|\s+\| 07월 16일 \| 2\.75 \|/.test(tt), "표를 칸 병합까지 살린 마크다운 표로");
  ok(tt.includes("표: 기준금리"), "표 제목(caption) 표시");

  // 4) 기사 페이지: 메뉴·많이 본 기사 제외
  const menu = Array.from({ length: 40 }, (_, i) => `<li><a href="/m${i}">메뉴 항목 ${i}</a></li>`).join("");
  pages["/article"] = { body: `<html><head><meta property="og:type" content="article"><title>기사 제목</title></head><body><nav><ul>${menu}</ul></nav>
<div class="wrap"><div class="art"><h1>기사 제목</h1><div id="article-body"><p>${para}</p><p>${para}</p><p>둘째 문단 끝 문장입니다.</p></div></div>
<div class="rank"><h3>많이 본 기사</h3><ul>${Array.from({ length: 10 }, (_, i) => `<li><a href="/a${i}">많이 본 기사 제목 ${i}번 입니다</a></li>`).join("")}</ul></div></div><footer>회사 주소 꼬리말</footer></body></html>` };
  r = await read("/article");
  const at = r.structuredContent.text;
  ok(r.structuredContent.mode === "article" && at.includes("둘째 문단 끝 문장") && !at.includes("메뉴 항목 3") && !at.includes("많이 본 기사 제목 3번"), "기사 본문만 고름(메뉴·많이 본 기사 제외)");

  // 5) 목록 페이지(기사 표시 없음)는 목록을 지우지 않음
  const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>${100 - i}</td><td><a href="/v${i}">보도자료 제목 ${i} — 정책 발표 안내</a></td><td>2026-11-0${i % 9 + 1}</td></tr>`).join("");
  pages["/list"] = { body: `<html><body><nav>${menu}</nav><div id="contents"><h2>보도자료</h2><table><tr><th>번호</th><th>제목</th><th>날짜</th></tr>${rows}</table></div></body></html>` };
  r = await read("/list", { links: true });
  ok(!r.isError && r.structuredContent.text.includes("보도자료 제목 11") && r.structuredContent.links[0].url.includes("/v0"), "목록 페이지는 목록 유지, 링크는 본문 링크 먼저");

  // 6) 자바스크립트로 그리는 기사: Arc 데이터에서 꺼냄
  const arc = { headlines: { basic: "제목" }, content_elements: [{ type: "text", content: "첫 문단 <b>강조</b> 입니다. " + para }, { type: "image", url: "https://x/y.jpg" }, { type: "text", content: "둘째 문단입니다. " + para }] };
  pages["/arc"] = { body: `<html><head><title>아크</title></head><body><div id="fusion-app"></div><script>Fusion=window.Fusion||{};Fusion.globalContent=${JSON.stringify(arc)};Fusion.globalContentConfig={}</script></body></html>` };
  r = await read("/arc");
  ok(!r.isError && r.structuredContent.mode === "data" && r.structuredContent.text.includes("첫 문단 강조 입니다") && r.structuredContent.text.includes("둘째 문단입니다") && !r.structuredContent.text.includes("y.jpg"), "빈 화면 페이지는 Arc 내장 데이터에서 본문을 꺼냄");

  // 7) JSON-LD articleBody
  pages["/ld"] = { body: `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "NewsArticle", headline: "h", articleBody: "엘디 본문입니다. " + para })}</script></head><body><div id="root"></div></body></html>` };
  r = await read("/ld");
  ok(!r.isError && r.structuredContent.text.includes("엘디 본문입니다"), "빈 화면 페이지는 JSON-LD articleBody에서 본문을 꺼냄");

  // 8) 같은 사이트 iframe 따라가기
  pages["/frame"] = { body: `<html><body><iframe id="contentFrame" src="/inner"></iframe></body></html>` };
  pages["/inner"] = { body: `<html><body><p>틀 안 본문입니다. ${para}</p></body></html>` };
  r = await read("/frame");
  ok(!r.isError && r.structuredContent.mode === "iframe" && r.structuredContent.text.includes("틀 안 본문입니다"), "본문이 iframe에 있으면 같은 사이트 iframe을 읽음");

  // 9) 메뉴만 있는 짧은 페이지는 본문 없음으로 판정(direct_only면 실패, 유료 호출 없음)
  pages["/menuonly"] = { body: `<html><body><div>${Array.from({ length: 15 }, (_, i) => `<p><a href="/x${i}">메뉴${i}</a></p>`).join("")}</div></body></html>` };
  r = await read("/menuonly");
  ok(r.isError && paidCalls === 0, "메뉴만 있는 짧은 페이지는 본문 없음으로 판정(direct_only, 유료 호출 0)");

  // 10) DOCX — content-type에 'xml'이 있어도 글이 아니라 파일로 받음, 병합 칸 표
  const dz = new JSZip();
  dz.file("[Content_Types].xml", "<Types/>");
  dz.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>워드 첫 문단</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>머리</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>값</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>a1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>a2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  pages["/doc"] = { body: await dz.generateAsync({ type: "nodebuffer" }), headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } };
  r = await read("/doc");
  const dt = r.structuredContent && r.structuredContent.text || "";
  ok(!r.isError && r.structuredContent.via === "docx" && dt.includes("워드 첫 문단") && dt.includes("| 머리 |  | 값 |") && dt.includes("| A | a1 | 1 |") && dt.includes("|  | a2 | 2 |"), "DOCX 문단·병합 칸 표");

  // 11) XLSX — 공유 문자열·날짜 서식·자기닫힘 빈 칸·빈 행 번호
  const xz = new JSZip();
  xz.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="자료" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  xz.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`);
  xz.file("xl/sharedStrings.xml", `<sst><si><t>일자</t></si><si><t>금액</t></si><si><r><t>합</t></r><r><t>계</t></r></si></sst>`);
  xz.file("xl/styles.xml", `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`);
  xz.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="0"/><c r="C1" t="s"><v>1</v></c></row>
<row r="3"><c r="A3" s="1"><v>46327</v></c><c r="B3" s="0"/><c r="C3"><v>1500</v></c></row><row r="4"><c r="A4" t="s"><v>2</v></c><c r="C4"><v>1500</v></c></row></sheetData></worksheet>`);
  pages["/xls"] = { body: await xz.generateAsync({ type: "nodebuffer" }), headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\"a.xlsx\"" } };
  r = await read("/xls");
  const xt = r.structuredContent && r.structuredContent.text || "";
  ok(!r.isError && r.structuredContent.via === "xlsx" && xt.includes("## 시트: 자료") && xt.includes("| 일자 | 금액 |") && xt.includes("| 2026-11-01 | 1500 |") && xt.includes("| 합계 | 1500 |"), "XLSX 시트·공유 문자열·날짜·빈 칸");

  // 12) 구형 오피스(OLE, 한글 아님)는 사유를 돌려줌
  const ole = Buffer.alloc(1024); Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole);
  pages["/old"] = { body: ole, headers: { "content-type": "application/msword" } };
  r = await read("/old");
  ok(r.isError && /구형 오피스|읽지 못/.test(r.content[0].text), "구형 doc·xls는 사유를 밝혀 실패");

  // 13) 1열 배치용 표는 문단으로 풀림
  const lt = html._test.nodeText((await html.libs()).parseHTML(`<html><body><table><tr><td><p>위 문단</p><p>아래 문단</p></td></tr><tr><td>둘째 칸</td></tr></table></body></html>`).document.body);
  ok(lt.includes("위 문단") && !lt.includes("| ---"), "1열 배치용 표는 마크다운 표로 만들지 않음");

  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
