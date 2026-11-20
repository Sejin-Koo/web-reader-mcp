// 직접 접속의 연결 단계 실패를 한 번 더 받는지. 실행: node test/direct-retry.smoke.js
const usage = require("../lib/usage");
usage.configured = () => false;
let calls = 0, plan = [];
global.fetch = async (u) => {
  u = String(u);
  if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
  calls++; const s = plan.shift() || "ok";
  if (s === "fail") { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNRESET" }; throw e; }
  return new Response("<html><body><article>" + "본문 내용 ".repeat(200) + "</article></body></html>", { status: 200, headers: { "content-type": "text/html" } });
};
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  plan = ["fail"]; calls = 0;
  const r = await web.call("fetch_page", { url: "https://retry.example.kr/a", direct_only: true }, "t1");
  ok(!r.isError && calls === 2, `한 번 끊긴 뒤 다시 받아 성공 (호출 ${calls})`);
  plan = ["fail", "fail"]; calls = 0;
  const r2 = await web.call("fetch_page", { url: "https://retry.example.kr/b", direct_only: true }, "t2");
  ok(r2.isError && calls === 2 && /2회 시도/.test(r2.content[0].text), "두 번 끊기면 실패 안내(2회 시도): " + r2.content[0].text.slice(0, 90));
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
