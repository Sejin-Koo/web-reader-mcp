// 첨부 세션 내려받기 스모크테스트(2026-11-16) — 파일 대신 안내 화면이 오면 첨부가 있던 페이지(referer → 그누보드 글 보기 → 사이트 첫 화면)를
// 먼저 열어 받은 쿠키·Referer로 한 번 더 받는지. 실행: node test/attach-session.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.TAVILY_API_KEY = "x";
const JSZip = require("jszip");
const usage = require("../lib/usage");
usage.configured = () => false;
const log = [];
let docx;
// 사이트 규칙: /view* 또는 / 를 열면 SID 쿠키를 준다. 내려받기는 SID 쿠키(+필요하면 Referer)가 있어야 파일, 없으면 안내 HTML(또는 403)
const rules = {
  "/dl/a.do": { need: "sid", referer: null },            // 쿠키만 있으면 됨
  "/dl/b.do": { need: "sid", referer: "/view/b" },        // 쿠키 + 그 글의 Referer
  "/dl/c.do": { need: "sid", status: 403 },              // 세션 없으면 403
  "/bbs/download.php": { need: "sid", referer: "/bbs/board.php" },
  "/dl/open.do": { need: null },                          // 바로 받아짐
  "/page/news": { page: true }                            // 일반 페이지(내려받기 아님)
};
global.fetch = async (u, opt) => {
  u = new URL(String(u)); const h = (opt && opt.headers) || {};
  log.push(`${u.pathname}${u.search}|${h.Cookie || ""}|${h.Referer || ""}`);
  if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
  if (/nimbleway|tavily/.test(u.hostname)) return new Response("{}", { status: 500 });
  if (u.pathname === "/" || u.pathname.startsWith("/view") || u.pathname === "/bbs/board.php") return new Response(`<html><body><p>${"글 ".repeat(200)}</p></body></html>`, { status: 200, headers: { "content-type": "text/html", "set-cookie": "SID=abc; Path=/" } });
  const r = rules[u.pathname];
  if (!r) return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
  if (r.page) return new Response(`<html><body><p>${"기사 본문 ".repeat(100)}</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  const hasCookie = /SID=abc/.test(h.Cookie || "");
  const refOk = !r.referer || String(h.Referer || "").includes(r.referer);
  if (!r.need || (hasCookie && refOk)) return new Response(docx, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": "attachment; filename=\"a.docx\"" } });
  if (r.status) return new Response("forbidden", { status: r.status, headers: { "content-type": "text/html" } });
  return new Response(`<html><body><script>alert('잘못된 접근입니다');history.back();</script></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
};
require("dns").promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
const read = (path, extra) => web.call("fetch_page", Object.assign({ url: "https://s.example.or.kr" + path, direct_only: true }, extra || {}), "koo");
(async () => {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>첨부 본문 확인용 문장입니다.</w:t></w:r></w:p></w:body></w:document>`);
  docx = await z.generateAsync({ type: "nodebuffer" });
  const text = r => (r.content && r.content[0] && r.content[0].text) || "";

  let r = await read("/dl/a.do?fileId=1");
  ok(!r.isError && text(r).includes("첨부 본문 확인용") && text(r).includes("먼저 열어"), "referer 없이: 사이트 첫 화면 쿠키로 받음");
  r = await read("/dl/b.do?fileId=2", { referer: "https://s.example.or.kr/view/b?id=2" });
  ok(!r.isError && text(r).includes("첨부 본문 확인용"), "referer 인자: 그 글을 열고 쿠키·Referer로 받음");
  r = await read("/dl/b.do?fileId=2");
  ok(r.isError && /첨부 세션/.test(text(r)), "글 Referer가 필요한데 referer가 없으면 실패하고 시도 내역을 밝힘");
  r = await read("/dl/c.do?atchFileId=3");
  ok(!r.isError && text(r).includes("첨부 본문 확인용"), "세션 없이 403인 첨부도 다시 받음");
  r = await read("/bbs/download.php?bo_table=law&wr_id=9&no=0");
  ok(!r.isError && text(r).includes("첨부 본문 확인용"), "그누보드: 글 보기(board.php)를 열고 받음");
  log.length = 0;
  r = await read("/dl/open.do?fileId=4");
  ok(!r.isError && log.filter(x => !x.startsWith("/robots")).length === 1, "바로 받아지는 첨부는 추가 요청 없음");
  log.length = 0;
  r = await read("/page/news");
  ok(!r.isError && log.filter(x => !x.startsWith("/robots")).length === 1, "내려받기 주소가 아닌 일반 페이지는 추가 요청 없음");
  log.length = 0;
  r = await read("/dl/b.do?fileId=2", { referer: "https://evil.example.com/view/b" });
  ok(!log.some(x => x.includes("evil")), "다른 사이트 referer는 쓰지 않음");
  console.log(`\n통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})();
