// 회사 측 사용량 스모크테스트 — 가짜 Redis·가짜 Tavily·Nimble 응답. 실행: node test/vendor-usage.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.TAVILY_API_KEY = "x";
const usage = require("../lib/usage");
const day = usage.kstDate();
const kv = { [`wu:${day}:callers`]: ["koo", "kim"], [`wu:${day}:koo`]: ["account|tavily.search", "3", "account|tavily.search#err", "1", "account|nimble.extract", "2", "account|tool.web_search", "4"], [`wu:${day}:kim`]: ["agent|tavily.search", "5", "agent|tavily.extract", "1"], [`w:nimble:${day.slice(0, 7)}`]: "6" };
usage.configured = () => true;
usage.pipeline = async cmds => cmds.map(([op, k]) => op === "SMEMBERS" ? (kv[k] || []) : op === "HGETALL" ? (kv[k] || []) : op === "GET" ? (kv[k] ?? null) : 1);
let nimbleUrl = "";
global.fetch = async (u) => {
  u = String(u);
  if (u.includes("tavily")) return new Response(JSON.stringify({ key: { usage: 12, limit: null, search_usage: 9, extract_usage: 3 }, account: { current_plan: "Researcher", plan_usage: 40, plan_limit: 1000, paygo_usage: 0, paygo_limit: 1000 } }), { status: 200 });
  nimbleUrl = u;
  return new Response(JSON.stringify({ data: [
    { dimensions: { api_key: null }, metrics: { requests: 80, errors: 1, cost_usd: "0.01" } },
    { dimensions: { api_key: "aaaa" }, metrics: { requests: 7, errors: 0, cost_usd: "0.01" } },
    { dimensions: { api_key: "bbbb" }, metrics: { requests: 30, errors: 0, cost_usd: "0.00" } }
  ], totals: { requests: 117, cost_usd: "0.02" }, meta: { start: "2026-11-01T00:00:00Z", end: "2026-11-10T00:00:00Z", partial: true, last_usage_at: "2026-11-09T00:00:00Z", excluded_services: ["ip"] } }), { status: 200 });
};
const vendor = require("../lib/vendor");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  let r = await vendor.report(); let s = r.structuredContent;
  console.log(r.content[0].text);
  ok(s.tavily.other === 28, `Tavily 전용 키 외 28 (${s.tavily.other})`);
  ok(s.paths.tavily.account === 3 && s.paths.tavily.agent === 6, "경로별 Tavily 호출 3/6 (실패 필드 제외)");
  ok(s.nimble.server === 7 && s.nimble.server_key_guessed, "키 id 미설정이면 월 카운터(6)에 가장 가까운 키를 추정");
  ok(s.nimble.keyless === 80, "키 없는 요청 80");
  ok(/group_by=api_key/.test(nimbleUrl) && /start=2026-\d\d-01T00/.test(decodeURIComponent(nimbleUrl)), "Nimble 이번 달·키별 조회");
  process.env.NIMBLE_KEY_ID = "bbbb"; process.env.NIMBLE_PERSONAL_KEY_ID = "aaaa";
  r = await vendor.report(); s = r.structuredContent;
  ok(s.nimble.server === 30 && !s.nimble.server_key_guessed && s.nimble.personal === 7, "환경변수로 키 지정");
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
