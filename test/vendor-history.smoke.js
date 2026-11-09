// 일별 저장·날짜별·월별 스모크테스트 — 가짜 Redis·가짜 회사 응답. 실행: node test/vendor-history.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.TAVILY_API_KEY = "x"; process.env.NIMBLE_KEY_ID = "own1"; process.env.NIMBLE_PERSONAL_KEY_ID = "per1";
const usage = require("../lib/usage");
const kv = new Map();
usage.configured = () => true;
usage.pipeline = async cmds => cmds.map(([op, k, ...r]) => {
  if (op === "HSET") { const h = kv.get(k) || new Map(); h.set(r[0], r[1]); kv.set(k, h); return 1; }
  if (op === "HGETALL") { const h = kv.get(k); if (!h || !(h instanceof Map)) return []; return [...h].flat(); }
  if (op === "SMEMBERS") return [];
  if (op === "GET") return null;
  return 1;
});
const today = usage.kstDate(), mo = today.slice(0, 7);
let tavTotal = 50, nimbleCalls = [];
global.fetch = async (u) => {
  u = String(u);
  if (u.includes("tavily")) return new Response(JSON.stringify({ key: { usage: 20 }, account: { plan_usage: tavTotal, plan_limit: 1000, paygo_usage: 0, paygo_limit: 1000 } }), { status: 200 });
  nimbleCalls.push(decodeURIComponent(u));
  if (u.includes("group_by=time")) return new Response(JSON.stringify({ data: [
    { timestamp: `${mo}-02T00:00:00Z`, dimensions: { api_key: null }, metrics: { requests: 5 } },
    { timestamp: `${mo}-02T00:00:00Z`, dimensions: { api_key: "own1" }, metrics: { requests: 3 } },
    { timestamp: `${mo}-03T00:00:00Z`, dimensions: { api_key: "per1" }, metrics: { requests: 2 } }
  ], totals: {}, meta: { total: 3, partial: true } }), { status: 200 });
  return new Response(JSON.stringify({ data: [{ dimensions: { api_key: null }, metrics: { requests: 9 } }, { dimensions: { api_key: "own1" }, metrics: { requests: 4 } }], totals: { requests: 13, cost_usd: "0.01" }, meta: { total: 2 } }), { status: 200 });
};
const vendor = require("../lib/vendor");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  // 어제 저장값을 미리 넣어 두고 오늘 report → 저장 → daily에서 차이 확인
  const yd = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  if (yd.slice(0, 7) === mo) kv.set(`wv:${mo}`, new Map([[yd, JSON.stringify({ tavily: { total: 30, key: 10 } })]]));
  await vendor.report({});
  const h = kv.get(`wv:${mo}`);
  ok(h && h.has(today) && JSON.parse(h.get(today)).tavily.total === 50, "current 조회 때 오늘 값 저장");
  const d = await vendor.report({ view: "daily" });
  console.log(d.content[0].text.split("\n").slice(0, 8).join("\n"));
  const tr = d.structuredContent.rows.find(r => r["날짜"] === today);
  if (yd.slice(0, 7) === mo) ok(tr && tr["Tavily"] === 20, `Tavily 하루 사용 = 오늘 50 − 어제 30 (${tr && tr["Tavily"]})`);
  else ok(tr && tr["Tavily"] === 50, "1일은 누적값이 그날 사용");
  const n2 = d.structuredContent.rows.find(r => r["날짜"] === `${mo}-02`);
  ok(n2 && n2["Nimble"] === 8 && n2["Nimble 커넥터 직접"] === 5 && n2["Nimble 전용 키"] === 3, "Nimble 날짜별 키 구분");
  const m = await vendor.report({ view: "monthly", months: 2 });
  console.log(m.content[0].text);
  const r0 = m.structuredContent.rows[0];
  ok(m.structuredContent.rows.length === 2 && r0["월"] === mo && r0["Tavily"] === 50 && r0["Tavily 커넥터 직접"] === 30 && r0["Nimble"] === 13 && r0["Nimble 커넥터 직접"] === 9, "월별: 이번 달 Tavily 마지막 저장값·Nimble 키별 합계");
  ok(m.structuredContent.rows[1]["Tavily"] === null, "저장 없는 지난달 Tavily는 비움");
  const j = await vendor.snapshotJob(); ok(j.ok && j.tavily === 50, "예약 실행 저장");
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
