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
module.exports = { kstDate, pipeline, configured: () => !!conf() };
