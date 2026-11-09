// Tavily·Nimble 회사 측 사용량을 하루 한 번 저장한다(Vercel 예약 실행 — vercel.json crons).
// Tavily는 청구 주기 누적값만 주므로 이 저장이 있어야 하루 사용량·지난달 합계를 볼 수 있다.
// 호출: Vercel 예약 실행(user-agent vercel-cron) 또는 관리자 게이트키(?k=). 저장 외에는 아무것도 바꾸지 않는다.
const vendor = require("../lib/vendor");
const GATE_KEYS = (process.env.MCP_GATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_LABELS = (process.env.WEB_ADMIN_LABELS || "koo,relay").split(",").map(s => s.trim()).filter(Boolean);
module.exports = async (req, res) => {
  let k = (req.query && req.query.k) || null;
  if (!k) { try { k = new URL(req.url, "http://localhost").searchParams.get("k"); } catch (e) { k = null; } }
  const m = String(k || "").match(/^plk_([A-Za-z0-9]+)_/);
  const isCron = /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
  const isAdmin = !!k && GATE_KEYS.includes(k) && m && ADMIN_LABELS.includes(m[1]);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!isCron && !isAdmin) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: "unauthorized" })); return; }
  try { const r = await vendor.snapshotJob(); console.log(`[vendor-snapshot] ${JSON.stringify(r)}`); res.statusCode = 200; res.end(JSON.stringify(r)); }
  catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
};
