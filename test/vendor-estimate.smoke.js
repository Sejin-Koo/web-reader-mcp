// 사용처별 추정 금액 스모크 — 가짜 Redis(경로 기록)·가짜 Nimble 응답. 실행: node test/vendor-estimate.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.NIMBLE_KEY_ID = "own"; process.env.NIMBLE_PERSONAL_KEY_ID = "per"; delete process.env.NIMBLE_PRICE_SEARCH_FAST;
const usage = require("../lib/usage");
const kv = {}, saved = {};
const today = usage.kstDate();
kv[`wu:${today}:callers`] = ["koo", "kim"];
kv[`wu:${today}:koo`] = ["account|nimble.search", "10", "account|nimble.extract", "3"];
kv[`wu:${today}:kim`] = ["agent|nimble.search", "5", "agent|nimble.extract", "2", "agent|nimble.extract#err", "1"];
usage.configured = () => true;
usage.pipeline = async cmds => cmds.map(([op, k, f, v]) => { if (op === "SMEMBERS" || op === "HGETALL") { if (k === "wvp") return Object.entries(saved).flat(); return kv[k] || []; } if (op === "HSET") { saved[f] = v; return 1; } if (op === "GET") return null; return 1; });
global.fetch = async u => {
  u = String(u);
  if (u.includes("remaining-credits")) return new Response(JSON.stringify({ billing: { spent_credits: 0.2, remaining_credits: 9.8, used_top_up: 10, billing_period_start: "2026-10-27 00:00:00 +0000 UTC", billing_period_end: "2026-11-27 00:00:00 +0000 UTC", credit_line: "Pre-Payment" } }), { status: 200 });
  if (/group_by=configuration/.test(u)) return new Response(JSON.stringify({ data: [
    { dimensions: { api_key: null, product: null, configuration: { key: null, name: "SEARCH_FAST" } }, metrics: { requests: 10, successes: 10 } },
    { dimensions: { api_key: null, product: null, configuration: { key: null, name: "SEARCH_LITE" } }, metrics: { requests: 20, successes: 20 } },
    { dimensions: { api_key: "own", product: null, configuration: { key: null, name: "SEARCH_LITE" } }, metrics: { requests: 20, successes: 20 } },
    { dimensions: { api_key: "own", product: { key: "extractApi" }, configuration: { key: "vx8", name: "Extract API VX8" } }, metrics: { requests: 9, successes: 8 } },
    { dimensions: { api_key: "per", product: { key: "extractApi" }, configuration: { key: "vx6", name: "Extract API VX6" } }, metrics: { requests: 4, successes: 4 } },
    { dimensions: { api_key: null, product: { key: "extractApi" }, configuration: { key: "vx6", name: "Extract API VX6" } }, metrics: { requests: 3, successes: 3 } },
    { dimensions: { api_key: null, product: { key: "extractApi" }, configuration: { key: "vx8", name: "Extract API VX8" } }, metrics: { requests: 2, successes: 2 } }
  ], totals: {}, meta: {} }), { status: 200 });
  return new Response(JSON.stringify({ data: [], totals: { requests: 0 }, meta: {} }), { status: 200 });
};
const vendor = require("../lib/vendor");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  const r = await vendor.report({ view: "estimate" }), e = r.structuredContent;
  console.log(r.content[0].text);
  const row = (src, item, user) => e.rows.find(o => o["출처"].startsWith(src) && o["항목"] === item && (user === undefined || o["사용자"] === user));
  ok(row("계정 채팅 — Nimble", "검색 fast")["추정 금액"] === 0.063, "fast 10건 × $6.3/1,000");
  ok(row("계정 채팅 — Nimble", "읽기")["건수"] === 5, "처리 방식만 다른 읽기는 한 줄로 합침(3+2)");
  ok(row("계정 채팅 — 웹 도구", "검색 lite", "(계정)")["건수"] === 10 && row("업무 에이전트", "검색 lite", "kim")["건수"] === 5, "웹 도구 서버 검색을 경로 기록으로 나눔(10·5)");
  ok(row("웹 도구 서버(경로 미분류", "검색 lite")["건수"] === 5, "경로 기록보다 많은 몫은 미분류(20−15)");
  ok(row("업무 에이전트", "읽기", "kim")["건수"] === 2 && row("웹 도구 서버(경로 미분류", "읽기")["건수"] === 3, "읽기도 나눔, 실패 필드 제외(8 = 3+2+미분류3)");
  ok(row("공공데이터", "읽기")["추정 금액"] === 0.004, "본인 키 읽기 4건");
  const sum = Math.round(e.rows.reduce((a, o) => a + o["추정 금액"], 0) * 10000) / 10000;
  ok(sum === e.estimate && e.actual === 0.2 && Math.abs(e.gap - (0.2 - e.estimate)) < 1e-9, `합계·실제·차이 (${e.estimate}, ${e.actual}, ${e.gap})`);
  ok(e.implied_fast_per_1k !== null && Math.abs(e.implied_fast_per_1k - (0.2 - (e.estimate - 0.063)) / 10 * 1000) < 0.01, `fast 역산 단가 ${e.implied_fast_per_1k}`);
  ok(saved["2026-10-27"] && JSON.parse(saved["2026-10-27"]).actual === 0.2, "결제 주기별 기록 저장(wvp)");
  const p = await vendor.report({ view: "periods" });
  ok(p.structuredContent.rows.length === 1 && p.structuredContent.rows[0]["실제 차감액"] === 0.2, "periods 보기");
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})();
