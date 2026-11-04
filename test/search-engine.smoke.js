// web_search 엔진·깊이·Nimble 국가 지정 스모크테스트 — 가짜 Redis·가짜 네트워크. 실행: node test/search-engine.smoke.js
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
const calls = [];
let nimbleFail = false;
global.fetch = async (u, o) => {
  u = String(u); const body = o && o.body ? JSON.parse(o.body) : null;
  calls.push({ u, body });
  const json = x => new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("api.tavily.com/search")) return json({ results: [{ title: "10월 소비자물가 2.8% 상승", url: "https://news.example/a", content: "소비자물가 상승률 2.8%", score: 0.9 }] });
  if (u.includes("nimbleway.com/v2/search")) {
    if (nimbleFail) return new Response("err", { status: 500 });
    return json({ results: [{ title: "2026년 10월 소비자물가동향", url: "https://mods.go.kr/x", description: "소비자물가 2.8% 상승" }] });
  }
  return new Response("", { status: 404 });
};
const web = require("../lib/web");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
const last = h => [...calls].reverse().find(c => c.u.includes(h));
(async () => {
  const Q = "2026년 10월 소비자물가 상승률";
  calls.length = 0;
  let r = await web.call("web_search", { query: Q }, "t1");
  ok(calls.length === 1 && calls[0].u.includes("tavily") && calls[0].body.search_depth === "basic", "기본: Tavily basic 1회만");
  calls.length = 0;
  r = await web.call("web_search", { query: Q, depth: "advanced" }, "t1");
  ok(last("tavily").body.search_depth === "advanced", "depth=advanced 전달");
  calls.length = 0;
  r = await web.call("web_search", { query: Q, engine: "nimble" }, "t1");
  const nb = last("nimbleway");
  ok(calls.length === 1 && nb && nb.body.country === "KR" && nb.body.locale === "ko" && nb.body.search_depth === "lite", "engine=nimble: Nimble만, 한글 질의는 KR·ko·lite");
  ok((r.structuredContent || {}).engine === "nimble" && /mods\.go\.kr/.test(r.content[0].text), "Nimble 결과 반환");
  calls.length = 0;
  r = await web.call("web_search", { query: "Apple fiscal 2026 fourth quarter results", engine: "nimble" }, "t1");
  ok(!("country" in last("nimbleway").body), "영문 질의는 국가 지정 안 함");
  calls.length = 0;
  r = await web.call("web_search", { query: "トヨタ 決算", engine: "nimble", country: "japan" }, "t1");
  ok(last("nimbleway").body.country === "JP" && last("nimbleway").body.locale === "ja", "country=japan → JP·ja");
  calls.length = 0; nimbleFail = true;
  r = await web.call("web_search", { query: Q, engine: "nimble" }, "t1");
  ok(!r.isError && /Nimble 실패 대체/.test((r.structuredContent || {}).engine || ""), "Nimble 실패 시 Tavily로 대체");
  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
