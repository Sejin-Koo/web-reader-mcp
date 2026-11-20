// fetch_page 전체 시간 예산: 직접 접속이 늦고 대체 경로도 늦어도 예산 안에 실패 안내를 돌려주는지. 실행: node test/fetch-budget.smoke.js
process.env.NIMBLE_API_KEY = "x"; process.env.TAVILY_API_KEY = "x"; process.env.FETCH_BUDGET_MS = "9000";
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
const calls = []; let directWait = 0;
const hang = (o) => new Promise((_, rej) => { const s = o && o.signal; if (s) s.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); }); });
global.fetch = async (u, o) => {
  u = String(u);
  if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
  if (u.includes("nimbleway")) { calls.push("nimble"); return hang(o); }
  if (u.includes("tavily")) { calls.push("tavily"); return hang(o); }
  calls.push("direct"); directWait = Date.now(); return hang(o);
};
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
(async () => {
  let t0 = Date.now();
  const r = await web.call("fetch_page", { url: "https://ksp.example.kr/ksp/article/file/68496.pdf" }, "tester");
  const ms = Date.now() - t0;
  ok(r.isError && ms < 9000 + 3000, `PDF 주소: 예산(9초) 안에 끝남 (${ms}ms)`);
  ok(!calls.includes("nimble"), "PDF로 보이는 주소는 Nimble을 건너뜀");
  ok(/시간 한도|응답 시간 초과|aborted/.test(r.content[0].text), "실패 안내에 시간 초과·한도 사유: " + r.content[0].text.slice(0, 120));
  calls.length = 0; kv.clear(); t0 = Date.now();
  const r2 = await web.call("fetch_page", { url: "https://slow.example.kr/news/1" }, "tester2");
  const ms2 = Date.now() - t0;
  ok(r2.isError && ms2 < 9000 + 3000, `일반 주소: 예산 안에 끝남 (${ms2}ms) 경로 ${calls.join(">")}`);
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
