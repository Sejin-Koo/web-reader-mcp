// 한도 카운터 저장소(Upstash Redis REST). 업무 에이전트 중계 서버와 같은 저장소를 써서
// 사람별 하루 한도·Nimble 월 한도 카운터가 이전 전후로 이어진다(키 접두어 w:).
function conf() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
function kstDate(d) {
  return new Date((d ? d.getTime() : Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
async function pipeline(cmds, timeoutMs) {
  const c = conf();
  if (!c) throw new Error("한도 카운터 저장소(KV_REST_API_URL·KV_REST_API_TOKEN)가 설정되지 않았습니다");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${c.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
      signal: ctl.signal
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`저장소 응답 HTTP ${r.status}`);
    return j.map(x => { if (x && x.error) throw new Error(x.error); return x ? x.result : null; });
  } finally {
    clearTimeout(timer);
  }
}
// ---- 경로별 사용 기록(2026-11-07): 누가(caller) 어느 쪽에서(account 계정 커넥터 / agent 업무 에이전트) 도구를 몇 번 불렀고,
// 그중 유료 경로(Tavily·Nimble)를 몇 번 탔는지 하루 단위로 센다. 질문·주소·본문은 남기지 않는다.
// 키: wu:<YYYY-MM-DD>:callers(집합), wu:<YYYY-MM-DD>:<caller>(해시) — 필드 "<channel>|<항목>", 실패는 "#err"를 붙인 필드.
// 항목: tool.web_search · tool.fetch_page(도구 호출), tavily.search · tavily.extract · nimble.search · nimble.extract(외부 요청).
// 보관: WEB_USAGE_RETENTION_DAYS(기본 90일). 중계 서버 relay_usage(group_by web_paths)가 같은 저장소에서 읽는다.
const RETAIN = Math.max(7, Number(process.env.WEB_USAGE_RETENTION_DAYS) || 90) * 86400;
function cleanId(x) { return String(x || "").replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 64) || "(none)"; }
async function recordPath(caller, channel, item, ok) {
  if (!conf()) return;
  const c = cleanId(caller), ch = channel === "agent" ? "agent" : "account", day = kstDate();
  const h = `wu:${day}:${c}`, s = `wu:${day}:callers`, f = `${ch}|${item}`;
  const cmds = [["SADD", s, c], ["HINCRBY", h, f, "1"], ["EXPIRE", s, String(RETAIN)], ["EXPIRE", h, String(RETAIN)]];
  if (!ok) cmds.splice(2, 0, ["HINCRBY", h, `${f}#err`, "1"]);
  try { await pipeline(cmds, 1500); } catch (e) { console.log(`[usage] 경로 기록 실패: ${e.message}`); }
}

module.exports = { kstDate, pipeline, recordPath, configured: () => !!conf() };
