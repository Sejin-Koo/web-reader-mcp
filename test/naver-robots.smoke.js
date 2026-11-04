// 네이버 robots 거부 시 브라우저로 보내지 않고 originallink 안내를 주는지. 실행: node test/naver-robots.smoke.js
global.fetch = async (u) => {
  u = String(u);
  if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
  return new Response("<html>x</html>", { status: 200, headers: { "content-type": "text/html" } });
};
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  const r = await web.call("fetch_page", { url: "https://n.news.naver.com/mnews/article/001/0000000001" }, "tester");
  const t = r.content[0].text;
  ok(r.isError && /originallink/.test(t) && /브라우저를 시도하지/.test(t), "네이버: 브라우저 대신 originallink 안내");
  const r2 = await web.call("fetch_page", { url: "https://example.org/x" }, "tester");
  ok(r2.isError && /바로 그 브라우저로/.test(r2.content[0].text), "다른 사이트: 브라우저 안내 유지");
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
