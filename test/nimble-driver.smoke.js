// Nimble 대체 경로가 렌더링 드라이버(vx8)로 부르고, 첫 결과가 얇으면 기다렸다 한 번 더 읽는지. 실행: node test/nimble-driver.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.TAVILY_API_KEY = "x";
const usage = require("../lib/usage");
const kv = new Map();
usage.configured = () => true;
usage.pipeline = async cmds => cmds.map(([op, k, ...r]) => {
  if (op === "GET") return kv.get(k) ?? null;
  if (op === "SET") { kv.set(k, r[0]); return "OK"; }
  if (op === "INCR") { const n = (Number(kv.get(k)) || 0) + 1; kv.set(k, String(n)); return n; }
  if (op === "DECR") { const n = (Number(kv.get(k)) || 0) - 1; kv.set(k, String(n)); return n; }
  return 1;
});
const bodies = [];
global.fetch = async (u, o) => {
  u = String(u);
  if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
  if (u.includes("nimbleway")) {
    const b = JSON.parse(o.body); bodies.push(b);
    const md = b.browser_actions ? "연설 본문 ".repeat(200) : "메뉴";
    return new Response(JSON.stringify({ status: "success", data: { markdown: md }, url: b.url }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("<html><body><div id=app></div><script>x</script></body></html>", { status: 200, headers: { "content-type": "text/html" } });
};
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  const r = await web.call("fetch_page", { url: "https://ec.europa.eu/commission/presscorner/detail/en/speech_26_2150" }, "tester");
  ok(bodies[0] && bodies[0].driver === "vx8" && bodies[0].render === true, "첫 호출: driver vx8 + render");
  ok(bodies.length === 2 && bodies[1].browser_actions && bodies[1].browser_actions[0].wait === 3000, "얇으면 3초 기다려 한 번 더");
  ok(!r.isError && (r.structuredContent || {}).via === "nimble" && /연설 본문/.test(r.content[0].text), "두 번째 결과(본문)를 돌려줌");
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
