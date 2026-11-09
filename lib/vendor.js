// 회사 측 사용량(2026-11-09): Tavily·Nimble 회사가 집계한 이번 달 사용량을 불러와,
// 이 서버(전용 키)가 쓴 몫과 그 밖의 사용(계정 채팅에서 Tavily·Nimble 커넥터를 직접 부른 것 등)으로 나눠 보여 준다.
// 관리자 전용 도구 web_vendor_usage — 계정 커넥터(관리자 키)와 중계 서버 relay_usage(group_by web_vendor)가 부른다.
//
// Tavily: GET https://api.tavily.com/usage — 전용 키(TAVILY_API_KEY)의 이번 청구 주기 크레딧(key)과 계정 전체(account).
//   단위는 크레딧이다(호출 수가 아님 — 기본 검색 1, 심화 검색 2, 읽기는 성공 5건당 1).
// Nimble: GET https://sdk.nimbleway.com/v2/usage?group_by=api_key — 계정 전체 요청을 키별로. 키가 없는 요청(api_key null)은
//   Nimble 커넥터·대시보드에서 부른 것이다. 응답의 키 값은 키 자체가 아니라 키 id라서, 이 서버 키의 id는
//   환경변수 NIMBLE_KEY_ID로 정한다(없으면 이 서버의 이번 달 Nimble 카운터와 가장 가까운 키를 '추정'으로 표시).
//   NIMBLE_PERSONAL_KEY_ID가 있으면 그 키를 '사용자 본인 키'로 이름 붙인다. 날짜는 UTC 기준이고 최근 몇 시간은 아직 안 잡힐 수 있다.
const usage = require("./usage");

const TIMEOUT = 15000;
async function getJson(url, key) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${TIMEOUT / 1000}초 안에 응답 없음`);
    throw e;
  } finally { clearTimeout(t); }
}
const n = v => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));

async function tavily() {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { error: "TAVILY_API_KEY 없음" };
  try {
    const j = await getJson("https://api.tavily.com/usage", key);
    const k = j.key || {}, a = j.account || {};
    const keyUsed = n(k.usage), plan = n(a.plan_usage), paygo = n(a.paygo_usage);
    const total = plan === null ? null : plan + (paygo || 0);
    return {
      plan_name: a.current_plan || null,
      key: { usage: keyUsed, limit: n(k.limit), search: n(k.search_usage), extract: n(k.extract_usage) },
      account: { plan_usage: plan, plan_limit: n(a.plan_limit), paygo_usage: paygo, paygo_limit: n(a.paygo_limit), search: n(a.search_usage), extract: n(a.extract_usage), total },
      other: total === null || keyUsed === null ? null : Math.max(0, total - keyUsed)
    };
  } catch (e) { return { error: e.message }; }
}

function monthStartUtc() { const d = new Date(); return `${d.toISOString().slice(0, 7)}-01T00:00:00Z`; }

async function nimble(ownCount) {
  const key = process.env.NIMBLE_API_KEY;
  if (!key) return { error: "NIMBLE_API_KEY 없음" };
  try {
    const start = monthStartUtc();
    const q = `start=${encodeURIComponent(start)}&group_by=api_key&limit=200`;
    const j = await getJson(`https://sdk.nimbleway.com/v2/usage?${q}`, key);
    const rows = (j.data || []).map(r => ({ id: (r.dimensions || {}).api_key || null, requests: n((r.metrics || {}).requests) || 0, errors: n((r.metrics || {}).errors) || 0, cost: (r.metrics || {}).cost_usd ?? null }));
    let ownId = (process.env.NIMBLE_KEY_ID || "").trim().toLowerCase(), guessed = false;
    const keyed = rows.filter(r => r.id);
    if (!ownId && keyed.length && ownCount !== null) {
      ownId = keyed.slice().sort((x, y) => Math.abs(x.requests - ownCount) - Math.abs(y.requests - ownCount))[0].id; guessed = true;
    }
    const personalId = (process.env.NIMBLE_PERSONAL_KEY_ID || "").trim().toLowerCase();
    const kind = id => !id ? "keyless" : id === ownId ? "server" : id === personalId ? "personal" : "other";
    const sum = k => rows.filter(r => kind(r.id) === k).reduce((s, r) => s + r.requests, 0);
    const t = j.totals || {}, m = j.meta || {};
    return {
      range: { start: m.start || start, end: m.end || null }, partial: !!m.partial, last_usage_at: m.last_usage_at || null,
      excluded_services: m.excluded_services || [],
      total: n(t.requests) || 0, cost_usd: t.cost_usd ?? null,
      server: sum("server"), personal: sum("personal"), keyless: sum("keyless"), other: sum("other"),
      server_key_guessed: guessed, rows: rows.map(r => Object.assign({ kind: kind(r.id) }, r))
    };
  } catch (e) { return { error: e.message }; }
}

// 이 서버 경로별 기록(wu:)을 이번 달(한국시간 1일~오늘) 합산 — 계정 커넥터 / 업무 에이전트
async function pathCounts() {
  const today = usage.kstDate(), days = [];
  for (let d = Number(today.slice(8, 10)); d >= 1; d--) days.push(`${today.slice(0, 8)}${String(d).padStart(2, "0")}`);
  const out = { account: {}, agent: {} };
  if (!usage.configured()) return out;
  const callers = await usage.pipeline(days.map(d => ["SMEMBERS", `wu:${d}:callers`]), 8000);
  const pairs = [];
  days.forEach((d, i) => (callers[i] || []).forEach(c => pairs.push(`wu:${d}:${c}`)));
  if (!pairs.length) return out;
  const hashes = await usage.pipeline(pairs.map(h => ["HGETALL", h]), 8000);
  for (const flat of hashes) {
    for (let k = 0; flat && k + 1 < flat.length; k += 2) {
      const f = flat[k]; if (f.includes("#")) continue;
      const i = f.indexOf("|"), ch = f.slice(0, i) === "agent" ? "agent" : "account", item = f.slice(i + 1);
      out[ch][item] = (out[ch][item] || 0) + (Number(flat[k + 1]) || 0);
    }
  }
  return out;
}

async function ownNimbleMonth() {
  if (!usage.configured()) return null;
  try { const [v] = await usage.pipeline([["GET", `w:nimble:${usage.kstDate().slice(0, 7)}`]], 3000); return v === null ? 0 : Number(v) || 0; }
  catch (e) { return null; }
}

const fmt = v => (v === null || v === undefined ? "-" : Number(v).toLocaleString("en-US"));
async function report() {
  const [paths, own] = await Promise.all([pathCounts().catch(() => ({ account: {}, agent: {} })), ownNimbleMonth()]);
  const [tv, nb] = await Promise.all([tavily(), nimble(own)]);
  const pc = (ch, a, b) => (paths[ch][a] || 0) + (paths[ch][b] || 0);
  const tvAcc = pc("account", "tavily.search", "tavily.extract"), tvAg = pc("agent", "tavily.search", "tavily.extract");
  const nbAcc = pc("account", "nimble.search", "nimble.extract"), nbAg = pc("agent", "nimble.search", "nimble.extract");
  const L = [`회사 측 사용량 — 이번 달 (조회 ${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} 한국시간)`, ""];
  L.push("## Tavily (단위: 크레딧, 이번 청구 주기)");
  if (tv.error) L.push(`조회 실패: ${tv.error}`);
  else {
    L.push("| 구분 | 크레딧 | 비고 |", "|---|---:|---|");
    L.push(`| 계정 전체 | ${fmt(tv.account.total)} | 플랜 ${fmt(tv.account.plan_usage)} / ${fmt(tv.account.plan_limit)}, 종량제 ${fmt(tv.account.paygo_usage)} / ${fmt(tv.account.paygo_limit)} |`);
    L.push(`| 웹 도구 서버(전용 키) | ${fmt(tv.key.usage)} | 검색 ${fmt(tv.key.search)}·읽기 ${fmt(tv.key.extract)} — 이번 달 호출: 계정 경로 ${tvAcc}, 업무 에이전트 경로 ${tvAg} |`);
    L.push(`| 전용 키 외(커넥터 직접 호출 등) | ${fmt(tv.other)} | 계정 전체 − 전용 키 |`);
  }
  L.push("", "## Nimble (단위: 요청 수, 이번 달 UTC 기준)");
  if (nb.error) L.push(`조회 실패: ${nb.error}`);
  else {
    L.push("| 구분 | 요청 | 비고 |", "|---|---:|---|");
    L.push(`| 계정 전체 | ${fmt(nb.total)} | 무료 제공 월 5,000 기준${nb.cost_usd !== null ? `, 과금 기준 비용 $${nb.cost_usd}` : ""} |`);
    L.push(`| 웹 도구 서버(전용 키) | ${fmt(nb.server)} | ${nb.server_key_guessed ? "키 id 추정(NIMBLE_KEY_ID 미설정) — " : ""}이번 달 호출: 계정 경로 ${nbAcc}, 업무 에이전트 경로 ${nbAg}${own !== null ? `, 서버 월 카운터 ${own}` : ""} |`);
    if (nb.personal || process.env.NIMBLE_PERSONAL_KEY_ID) L.push(`| 사용자 본인 키(다른 자체 서버) | ${fmt(nb.personal)} | 공공데이터 등 서버의 국내 접속 대행 |`);
    L.push(`| 키 없는 요청(커넥터 직접 호출·대시보드) | ${fmt(nb.keyless)} | |`);
    if (nb.other) L.push(`| 그 밖의 키 | ${fmt(nb.other)} | |`);
    L.push("", `기간 ${nb.range.start} ~ ${nb.range.end || "현재"}${nb.partial ? " — 최근 시간대는 아직 집계 중일 수 있음" : ""}${nb.last_usage_at ? ` (마지막 반영 ${nb.last_usage_at})` : ""}${nb.excluded_services.length ? `, 키별로 나눌 수 없는 서비스 제외: ${nb.excluded_services.join(", ")}` : ""}`);
  }
  L.push("", "웹 도구 서버의 경로별 호출은 2026-11-07 이후 기록이고 한국시간 기준이라, 회사 집계(크레딧·UTC)와 단위·날짜 경계가 다릅니다.");
  // 표로 쓰기 좋은 행(대시보드용): 서비스·구분마다 사용량과 계정 전체 대비 비중
  const rows = [];
  const share = (v, t) => (t ? Math.round(v / t * 1000) / 1000 : null);
  if (!tv.error) {
    const t = tv.account.total;
    rows.push({ "서비스": "Tavily", "구분": "계정 전체", "사용량": t, "단위": "크레딧", "비중": t === null ? null : 1, "비고": `플랜 ${fmt(tv.account.plan_usage)} / ${fmt(tv.account.plan_limit)}, 종량제 ${fmt(tv.account.paygo_usage)} / ${fmt(tv.account.paygo_limit)}` });
    rows.push({ "서비스": "Tavily", "구분": "웹 도구 서버(전용 키)", "사용량": tv.key.usage, "단위": "크레딧", "비중": share(tv.key.usage, t), "비고": `검색 ${fmt(tv.key.search)}·읽기 ${fmt(tv.key.extract)} 크레딧, 이번 달 호출 계정 경로 ${tvAcc}·업무 에이전트 경로 ${tvAg}` });
    rows.push({ "서비스": "Tavily", "구분": "전용 키 외(커넥터 직접 호출 등)", "사용량": tv.other, "단위": "크레딧", "비중": share(tv.other, t), "비고": "계정 전체 − 전용 키" });
  }
  if (!nb.error) {
    const t = nb.total, base = `이번 달 UTC 기준${nb.partial ? ", 최근 몇 시간은 집계 중" : ""}`;
    rows.push({ "서비스": "Nimble", "구분": "계정 전체", "사용량": t, "단위": "요청", "비중": 1, "비고": `무료 제공 월 5,000 · ${base}` });
    rows.push({ "서비스": "Nimble", "구분": "웹 도구 서버(전용 키)", "사용량": nb.server, "단위": "요청", "비중": share(nb.server, t), "비고": `${nb.server_key_guessed ? "키 id 추정 · " : ""}이번 달 호출 계정 경로 ${nbAcc}·업무 에이전트 경로 ${nbAg}` });
    if (nb.personal || process.env.NIMBLE_PERSONAL_KEY_ID) rows.push({ "서비스": "Nimble", "구분": "사용자 본인 키(다른 자체 서버)", "사용량": nb.personal, "단위": "요청", "비중": share(nb.personal, t), "비고": "공공데이터 등 서버의 국내 접속 대행" });
    rows.push({ "서비스": "Nimble", "구분": "키 없는 요청(커넥터 직접 호출 등)", "사용량": nb.keyless, "단위": "요청", "비중": share(nb.keyless, t), "비고": "계정 채팅의 Nimble 커넥터·Nimble 대시보드" });
    if (nb.other) rows.push({ "서비스": "Nimble", "구분": "그 밖의 키", "사용량": nb.other, "단위": "요청", "비중": share(nb.other, t), "비고": "" });
  }
  return {
    content: [{ type: "text", text: L.join("\n") }],
    structuredContent: { rows, tavily: tv, nimble: nb, paths: { tavily: { account: tvAcc, agent: tvAg }, nimble: { account: nbAcc, agent: nbAg } }, server_nimble_month_counter: own }
  };
}

const TOOL = {
  name: "web_vendor_usage",
  description: "관리자 전용: Tavily·Nimble 회사가 집계한 이번 달 사용량을 계정 전체·이 서버 전용 키·그 밖(커넥터 직접 호출 등)으로 나눠 보여 준다. Tavily는 크레딧, Nimble은 요청 수 단위.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
};
module.exports = { TOOL, report, _test: { tavily, nimble, pathCounts } };
