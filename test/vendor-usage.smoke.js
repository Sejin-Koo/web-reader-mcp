// 회사 측 사용량 스모크테스트 — 가짜 Redis·가짜 Tavily·Nimble 응답. 실행: node test/vendor-usage.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.TAVILY_API_KEY = "x";
const usage = require("../lib/usage");
const day = usage.kstDate();
const kv = { [`wu:${day}:callers`]: ["koo", "kim"], [`wu:${day}:koo`]: ["account|tavily.search", "3", "account|tavily.search#err", "1", "account|nimble.extract", "2", "account|tool.web_search", "4"], [`wu:${day}:kim`]: ["agent|tavily.search", "5", "agent|tavily.extract", "1"], [`w:nimble:${day.slice(0, 7)}`]: "6" };
usage.configured = () => true;
usage.pipeline = async cmds => cmds.map(([op, k]) => op === "SMEMBERS" ? (kv[k] || []) : op === "HGETALL" ? (kv[k] || []) : op === "GET" ? (kv[k] ?? null) : 1);
let nimbleUrl = "", nimbleUrls = [];
global.fetch = async (u) => {
  u = String(u);
  if (u.includes("tavily")) return new Response(JSON.stringify({ key: { usage: 12, limit: null, search_usage: 9, extract_usage: 3 }, account: { current_plan: "Researcher", plan_usage: 40, plan_limit: 1000, paygo_usage: 0, paygo_limit: 1000 } }), { status: 200 });
  if (u.includes("api.nimbleway.com/api/v1/account/remaining-credits")) return new Response(JSON.stringify({ subscription_status: "active", billing: { spent_credits: 0.24455, remaining_credits: 9.75545, used_top_up: 10, max_top_up: 300, billing_period_start: "2026-10-27 00:00:00 +0000 UTC", billing_period_end: "2026-11-27 00:00:00 +0000 UTC", roll_over: true, auto_renewal: false, credit_line: "Pre-Payment", subscription_services: [{ name: "data", spent_requests: 157 }, { name: "wsa", spent_runs: 3 }] } }), { status: 200 });
  nimbleUrl = u; nimbleUrls.push(u);
  if (/granularity=month/.test(u)) { const d = new Date(); const pm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString(); const cm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
    return new Response(JSON.stringify({ data: [{ timestamp: pm, dimensions: {}, metrics: { requests: 500 } }, { timestamp: cm, dimensions: {}, metrics: { requests: 9999 } }], totals: {}, meta: { start: "2025-12-01T00:00:00Z" } }), { status: 200 }); }
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
  ok(nimbleUrls.some(x => /group_by=api_key/.test(x) && /start=2026-\d\d-01T00/.test(decodeURIComponent(x))), "Nimble 이번 달·키별 조회");
  ok(nimbleUrls.some(x => /granularity=month/.test(x) && /group_by=time/.test(x)), "Nimble 누적(월별) 조회");
  ok(s.summary.length === 2 && s.summary[1]["무료 제공"] === 5000 && s.summary[0]["이번 달 사용"] === 40, "요약 2행(무료 제공 Nimble 5,000)");
  ok(s.summary[1]["무료 방식"] === "누적" && s.summary[1]["누적 사용"] === 617 && s.summary[0]["무료 방식"] === "매월", `Nimble 누적·Tavily 매월 (${s.summary[1]["무료 방식"]} ${s.summary[1]["누적 사용"]})`);
  ok(s.summary[1]["과금 방식"] === "선불 충전" && s.summary[1]["충전 잔액"] === 9.75545 && s.summary[1]["충전액"] === 10 && s.summary[1]["주기 사용액"] === 0.24455 && s.summary[1]["주기 끝"] === "2026-11-27" && s.summary[1]["주기 요청"] === 157, "Nimble 선불 충전 잔액·주기 사용액");
  ok(s.summary[1]["주기 끝 예상 사용액"] > 0.24 && /선불 충전 잔액 \$9\.76/.test(s.summary[1]["과금 표시"]), `주기 끝 예상·과금 표시 (${s.summary[1]["주기 끝 예상 사용액"]}, ${s.summary[1]["과금 표시"]})`);
  ok(s.summary[1]["월말 누적 추정"] === 500 + s.summary[1]["월말 추정"], "누적 = 지난달까지 월별 합 + 이번 달 키별 합(월별의 이번 달 행은 무시), 월말 누적 추정 = 지난달까지 + 이번 달 월말 추정");
  const src = s.sources, tot = src[src.length - 1];
  const sumT = src.slice(0, -1).reduce((a, r) => a + (r.Tavily || 0), 0), sumN = src.slice(0, -1).reduce((a, r) => a + (r.Nimble || 0), 0);
  console.log(src.map(r => `${r["경로"]} | ${r["사용자"]} | ${r.Tavily} | ${r.Nimble}`).join("\n"));
  ok(sumT === tot.Tavily && sumN === tot.Nimble, `출처별 합 = 계정 전체 (Tavily ${sumT}/${tot.Tavily}, Nimble ${sumN}/${tot.Nimble})`);
  ok(src.some(r => r["경로"] === "업무 에이전트" && r["사용자"] === "kim" && r.Tavily === 6), "업무 에이전트 사용자별 행");
  ok(s.rows.length === 7 && s.rows[2]["사용량"] === 28 && s.rows[2]["비중"] === 0.7, "표 행 7개, Tavily 전용 키 외 28·비중 0.7");
  process.env.NIMBLE_KEY_ID = "bbbb"; process.env.NIMBLE_PERSONAL_KEY_ID = "aaaa";
  r = await vendor.report(); s = r.structuredContent;
  ok(s.nimble.server === 30 && !s.nimble.server_key_guessed && s.nimble.personal === 7, "환경변수로 키 지정");
  ok(s.rows.some(r => r["구분"].startsWith("사용자 본인 키") && r["사용량"] === 7), "본인 키 행");
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
