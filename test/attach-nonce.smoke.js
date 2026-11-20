// 첨부 주소의 일회용 값(nonce)이 글을 연 접속에 묶인 사이트(그누보드 5) — 다른 접속에서 얻은 주소로 부르면,
// 첨부 세션에서 글을 연 뒤 그 페이지에 있는 같은 첨부의 새 주소로 받는지(2026-11-20 kgba.or.kr 실측).
// 실행: node test/attach-nonce.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.TAVILY_API_KEY = "x";
const JSZip = require("jszip");
const usage = require("../lib/usage");
usage.configured = () => false;
let docx, seq = 0; const log = [];
global.fetch = async (u, opt) => {
  u = new URL(String(u)); const h = (opt && opt.headers) || {};
  log.push(`${u.pathname}${u.search}`);
  if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
  if (/nimbleway|tavily/.test(u.hostname)) return new Response("{}", { status: 500 });
  if (u.pathname === "/bbs/board.php") {
    seq++; const sid = `S${seq}`, nonce = `n${seq}|1795|abc${seq}`;
    return new Response(`<html><body><p>${"글 ".repeat(200)}</p><a href="https://s.example.or.kr/bbs/download.php?bo_table=02sub03&amp;wr_id=346&amp;no=0&amp;nonce=${nonce}">a.xlsx</a><a href="https://s.example.or.kr/bbs/download.php?bo_table=02sub03&amp;wr_id=346&amp;no=1&amp;nonce=${nonce}">b.docx</a></body></html>`, { status: 200, headers: { "content-type": "text/html", "set-cookie": `SID=${sid}; Path=/` } });
  }
  if (u.pathname === "/bbs/download.php") {
    const sid = (/SID=S(\d+)/.exec(h.Cookie || "") || [])[1];
    const good = sid && u.searchParams.get("nonce") === `n${sid}|1795|abc${sid}` && u.searchParams.get("no") === "1";
    if (good) return new Response(docx, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": "attachment; filename=\"b.docx\"" } });
    return new Response(`<html><body><script>alert('잘못된 접근');</script></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  }
  return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
};
require("dns").promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>첨부 본문 확인용 문장입니다.</w:t></w:r></w:p></w:body></w:document>`);
  docx = await z.generateAsync({ type: "nodebuffer" });
  const text = r => (r.content && r.content[0] && r.content[0].text) || "";
  const stale = "https://s.example.or.kr/bbs/download.php?bo_table=02sub03&wr_id=346&no=1&nonce=old|1|zzz";
  let r = await web.call("fetch_page", { url: stale, referer: "https://s.example.or.kr/bbs/board.php?bo_table=02sub03&wr_id=346", direct_only: true }, "koo");
  ok(!r.isError && text(r).includes("첨부 본문 확인용"), "다른 접속의 nonce 주소 + referer → 새 nonce 주소로 받음");
  ok(log.some(x => x.includes("no=1") && x.includes("nonce=n")), "같은 첨부 번호(no=1)의 새 주소를 고름");
  r = await web.call("fetch_page", { url: stale, direct_only: true }, "koo");
  ok(!r.isError && text(r).includes("첨부 본문 확인용"), "referer 없어도 그누보드 글 보기에서 새 주소를 찾음");
  const T = web._test.freshAttachUrl;
  ok(T(new URL("https://a.kr/dl?id=1"), `<a href="/dl?id=1&nonce=x">`, "https://a.kr/v") === null, "일회용 값이 없는 주소는 바꾸지 않음");
  ok(T(new URL("https://a.kr/dl?id=1&nonce=a"), `<a href="/dl?id=2&nonce=b">`, "https://a.kr/v") === null, "다른 첨부(id 다름)는 고르지 않음");
  ok(T(new URL("https://a.kr/dl?id=1&nonce=a"), `<a href="https://b.kr/dl?id=1&nonce=b">`, "https://a.kr/v") === null, "다른 사이트 주소는 고르지 않음");
  console.log(`\n통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})();
