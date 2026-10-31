// 유료 경로 보관 스모크테스트 — 가짜 Redis·가짜 네트워크. 실행: node test/paid-cache.smoke.js
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
let nimbleCalls = 0, directCalls = 0;
const longMd = "가".repeat(7000);
global.fetch = async (u, o) => {
  u = String(u);
  if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
  if (u.includes("nimbleway")) { nimbleCalls++; return new Response(JSON.stringify({ status: "success", data: { markdown: longMd }, url: "https://kind.krx.co.kr/smoke-test-page" }), { status: 200, headers: { "content-type": "application/json" } }); }
  directCalls++; return new Response("<html><body><div id=app></div><script>x</script></body></html>", { status: 200, headers: { "content-type": "text/html" } });
};
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  const U = "https://kind.krx.co.kr/smoke-test-page";
  const r1 = await web.call("fetch_page", { url: U, max_chars: 3000 }, "tester");
  const t1 = r1.content[0].text, s1 = r1.structuredContent || {};
  console.log("1차:", t1.split("\n").slice(0, 4).join(" | "));
  ok(nimbleCalls === 1, `1차 Nimble 호출 ${nimbleCalls}회`);
  const r2 = await web.call("fetch_page", { url: U, start: 3000, max_chars: 3000 }, "tester");
  const t2 = r2.content[0].text;
  console.log("2차:", t2.split("\n").slice(0, 4).join(" | "));
  ok(nimbleCalls === 1 && /서버 보관본/.test(t2), "이어 읽기는 보관본 사용(Nimble 재호출 없음)");
  ok(directCalls === 1, `직접 접속도 다시 하지 않음(${directCalls}회)`);
  const paid = [...kv].filter(([k]) => /paidfetch$/.test(k)).map(([, v]) => v);
  ok(paid[0] === "1", `유료 읽기 하루 카운터 ${paid[0]} (이어 읽기는 차감 안 됨)`);
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
