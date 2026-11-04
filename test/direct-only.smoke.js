// direct_only 스모크테스트 — 직접 접속이 실패하면 대체 경로(Nimble·Tavily)를 부르지 않고 실패를 돌려주는지. 실행: node test/direct-only.smoke.js
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
let paidCalls = 0;
const ok200 = "<html><head><title>원문</title></head><body><p>" + "본문 ".repeat(300) + "</p></body></html>";
global.fetch = async (u) => {
  u = String(u);
  if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
  if (u.includes("nimbleway") || u.includes("tavily")) { paidCalls++; return new Response(JSON.stringify({ status: "success", data: { markdown: "가".repeat(3000) }, results: [{ url: u, raw_content: "가".repeat(3000) }] }), { status: 200, headers: { "content-type": "application/json" } }); }
  if (u.includes("fsc.go.kr")) return new Response(ok200, { status: 200, headers: { "content-type": "text/html" } });
  return new Response("<html><body><div id=app></div><script>x</script></body></html>", { status: 200, headers: { "content-type": "text/html" } });
};
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  const r1 = await web.call("fetch_page", { url: "https://www.fsc.go.kr/smoke-a", direct_only: true }, "koo");
  ok(!r1.isError && (r1.structuredContent || {}).via === "direct", "직접 읽기 성공은 그대로 돌려줌");
  const r2 = await web.call("fetch_page", { url: "https://kind.krx.co.kr/smoke-b", direct_only: true }, "koo");
  ok(r2.isError && /direct_only/.test(r2.content[0].text) && paidCalls === 0, `직접 실패 시 대체 경로 없이 실패(유료 호출 ${paidCalls}회)`);
  ok(![...kv.keys()].some(k => /paidfetch$/.test(k)), "유료 읽기 카운터를 건드리지 않음");
  const r3 = await web.call("fetch_page", { url: "https://kind.krx.co.kr/smoke-c" }, "koo");
  ok(!r3.isError && paidCalls >= 1, "direct_only가 없으면 종전처럼 대체 경로 사용");
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
