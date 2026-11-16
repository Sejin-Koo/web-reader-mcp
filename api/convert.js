// 첨부 파일 변환 입구 — 계정 채팅의 내장 브라우저가 받은 첨부 파일(PDF·HWP·HWPX·DOCX·XLSX·PPTX)을 보내면 글로 바꿔 돌려준다.
// robots.txt로 이 서버가 직접 읽지 않는 사이트의 첨부를 브라우저(정식 경로)가 받아 넘길 때 쓴다(2026-11-16).
// 이 입구는 사이트에 접속하지 않고 받은 바이트만 변환한다.
//
// 호출: POST /api/convert?k=<CONVERT_KEYS의 키>&name=<파일 이름>&url=<원래 첨부 주소>&ocr=<스캔 PDF 시작 쪽>
//       본문은 파일 바이트 그대로(Content-Type 무관). 사이트 페이지 안에서 부르므로 CORS를 연다.
//       큰 파일은 나눠 보낼 수 있다: &id=<임의 문자열>&part=<0부터>&parts=<전체 수> — 마지막 조각을 받으면 합쳐 변환
// 응답: { ok, kind, filename, bytes, total_chars, text, notes, table_check } 또는 { ok:false, error }
// 키: CONVERT_KEYS(쉼표 구분) — 변환만 되는 별도 키. 사이트 페이지 안에서 실행되므로 MCP 게이트키를 쓰지 않는다.
const web = require("../lib/web");
const usage = require("../lib/usage");

const KEYS = (process.env.CONVERT_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_PARTS = 40;

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// 나눠 보낸 조각은 Redis에 10분 둔다(usage.js의 Redis 설정을 그대로 쓴다)
async function partSet(id, i, buf) { return usage.pipeline([["SET", `cv:${id}:${i}`, buf.toString("base64"), "EX", "600"]], 15000); }
async function partGet(id, i) { const [r] = await usage.pipeline([["GET", `cv:${id}:${i}`]], 15000); return r ? Buffer.from(String(r), "base64") : null; }
async function partDel(id, n) { try { await usage.pipeline(Array.from({ length: n }, (_, i) => ["DEL", `cv:${id}:${i}`]), 5000); } catch (e) { /* 무시 */ } }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST로 파일 바이트를 보내세요" });
  const q = new URL(req.url, "http://localhost").searchParams;
  const k = q.get("k") || "";
  if (!KEYS.length || !KEYS.includes(k)) return send(res, 401, { ok: false, error: "unauthorized" });
  let buf;
  try { buf = await readRaw(req); } catch (e) { return send(res, 400, { ok: false, error: `파일을 받지 못함(${e.message})` }); }
  const parts = Math.max(1, Math.min(MAX_PARTS, Number(q.get("parts")) || 1));
  if (parts > 1) {
    const id = String(q.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    const part = Number(q.get("part"));
    if (!id || !(part >= 0 && part < parts)) return send(res, 400, { ok: false, error: "조각 보내기에는 id·part(0부터)·parts가 필요" });
    if (!usage.configured()) return send(res, 500, { ok: false, error: "조각 보관소(Redis)가 설정되지 않음" });
    try { await partSet(id, part, buf); } catch (e) { return send(res, 500, { ok: false, error: `조각 보관 실패(${e.message})` }); }
    if (part < parts - 1) return send(res, 200, { ok: true, received: part + 1, parts });
    const all = [];
    for (let i = 0; i < parts; i++) { const b = await partGet(id, i); if (!b) return send(res, 400, { ok: false, error: `${i}번 조각이 없음(10분이 지났거나 보내지 않음)` }); all.push(b); }
    buf = Buffer.concat(all);
    await partDel(id, parts);
  }
  const t0 = Date.now();
  let r;
  try { r = await web.convertBuffer(buf, { filename: q.get("name") || "", url: q.get("url") || "", ocrFirst: q.get("ocr") }); }
  catch (e) { r = { ok: false, error: e.message }; }
  console.log(`[convert] bytes=${buf.length} parts=${parts} ms=${Date.now() - t0} ok=${r.ok} kind=${r.kind || ""}`);
  if (!r.ok) return send(res, 200, Object.assign({ bytes: buf.length }, r));
  send(res, 200, { ok: true, kind: r.kind, filename: r.filename, bytes: buf.length, total_chars: r.text.length, text: r.text, notes: r.notes, table_check: r.table_check });
};
