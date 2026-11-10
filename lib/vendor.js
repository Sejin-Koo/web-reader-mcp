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
function keyKinds() {
  return { own: (process.env.NIMBLE_KEY_ID || "").trim().toLowerCase(), personal: (process.env.NIMBLE_PERSONAL_KEY_ID || "").trim().toLowerCase() };
}
// Nimble 사용량 조회(여러 쪽이면 이어 받음, 최대 5쪽)
async function nimbleRows(params) {
  const key = process.env.NIMBLE_API_KEY;
  if (!key) throw new Error("NIMBLE_API_KEY 없음");
  let out = [], offset = 0, meta = {}, totals = {};
  for (let page = 0; page < 5; page++) {
    const q = params.concat([["limit", "200"], ["offset", String(offset)]]).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const j = await getJson(`https://sdk.nimbleway.com/v2/usage?${q}`, key);
    out = out.concat(j.data || []); meta = j.meta || {}; totals = j.totals || {};
    offset += 200;
    if (meta.truncated || !(meta.total > offset)) break;
  }
  return { rows: out, meta, totals };
}

// Nimble 무료 제공 5,000건은 매월 초기화가 아니라 처음 한 번 주는 체험분으로 본다(2026-11-10 — 문서의 Pricing·Billing FAQ는
// "Get started with 5,000 free web pages"로 적고, 마케팅 가격 페이지만 "5,000 free requests per month"로 적어 엇갈림 → 보수적으로 누적).
// 그래서 계정 누적 사용(회사 API가 주는 최근 12개월 월별 합)을 무료 제공과 비교한다. NIMBLE_FREE_MODE=monthly면 예전처럼 이번 달만 비교.
async function nimbleCumulative() {
  try {
    const d = new Date(), start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1)).toISOString().slice(0, 10) + "T00:00:00Z";
    const r = await nimbleRows([["start", start], ["group_by", "time"], ["granularity", "month"]]);
    // 이번 달 행은 월별 집계에 아직 안 올라오는 일이 있어(2026-11-10 실측: 11월 행 없음) 지난달까지만 더하고, 이번 달은 키별 조회 합계를 쓴다
    const cur = monthStartUtc().slice(0, 7);
    const prev = r.rows.filter(x => String(x.timestamp || "").slice(0, 7) < cur).reduce((a, x) => a + (Number((x.metrics || {}).requests) || 0), 0);
    return { prev, since: (r.meta && r.meta.start) || start, partial: !!(r.meta && r.meta.partial) };
  } catch (e) { return { error: e.message }; }
}

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
  const out = { account: {}, agent: {}, by: {} }; // by: "<channel>|<caller>" → 항목별 수
  if (!usage.configured()) return out;
  const callers = await usage.pipeline(days.map(d => ["SMEMBERS", `wu:${d}:callers`]), 8000);
  const pairs = [];
  days.forEach((d, i) => (callers[i] || []).forEach(c => pairs.push([c, `wu:${d}:${c}`])));
  if (!pairs.length) return out;
  const hashes = await usage.pipeline(pairs.map(([, h]) => ["HGETALL", h]), 8000);
  hashes.forEach((flat, j) => {
    const caller = pairs[j][0];
    for (let k = 0; flat && k + 1 < flat.length; k += 2) {
      const f = flat[k]; if (f.includes("#")) continue;
      const i = f.indexOf("|"), ch = f.slice(0, i) === "agent" ? "agent" : "account", item = f.slice(i + 1), v = Number(flat[k + 1]) || 0;
      out[ch][item] = (out[ch][item] || 0) + v;
      const b = out.by[`${ch}|${caller}`] || (out.by[`${ch}|${caller}`] = {});
      b[item] = (b[item] || 0) + v;
    }
  });
  return out;
}

async function ownNimbleMonth() {
  if (!usage.configured()) return null;
  try { const [v] = await usage.pipeline([["GET", `w:nimble:${usage.kstDate().slice(0, 7)}`]], 3000); return v === null ? 0 : Number(v) || 0; }
  catch (e) { return null; }
}

// ---- 일별 저장(2026-11-09): Tavily는 이번 청구 주기 누적값만 주므로, 날마다 누적값을 저장해 하루 사용량(전날과의 차)·지난달 합계를 만든다.
// 키 wv:<YYYY-MM>(한국시간 달) 해시, 필드 <YYYY-MM-DD> → {at, tavily:{total,key,plan,paygo,plan_limit,paygo_limit}, nimble:{total,server,personal,keyless,other}}.
// 보관 WEB_VENDOR_SNAPSHOT_DAYS(기본 400일 — 지난 12개월 비교용, 달마다 해시 1개·하루 1필드라 수 KB 수준).
// 저장 시점: Vercel 예약 실행(api/vendor-snapshot, 매일 한국시간 23시대)과 web_vendor_usage를 부를 때마다(같은 날은 덮어씀).
const SNAP_DAYS = () => Math.max(60, Number(process.env.WEB_VENDOR_SNAPSHOT_DAYS) || 400);
async function saveSnapshot(tv, nb) {
  if (!usage.configured() || (tv.error && nb.error)) return false;
  const day = usage.kstDate(), k = `wv:${day.slice(0, 7)}`;
  const v = { at: new Date().toISOString() };
  if (!tv.error) v.tavily = { total: tv.account.total, key: tv.key.usage, plan: tv.account.plan_usage, paygo: tv.account.paygo_usage, plan_limit: tv.account.plan_limit, paygo_limit: tv.account.paygo_limit };
  if (!nb.error) v.nimble = { total: nb.total, server: nb.server, personal: nb.personal, keyless: nb.keyless, other: nb.other };
  try { await usage.pipeline([["HSET", k, day, JSON.stringify(v)], ["EXPIRE", k, String(SNAP_DAYS() * 86400)]], 3000); return true; }
  catch (e) { console.log(`[vendor] 저장 실패: ${e.message}`); return false; }
}
async function readSnapshots(month) {
  if (!usage.configured()) return {};
  try {
    const [flat] = await usage.pipeline([["HGETALL", `wv:${month}`]], 3000);
    const o = {};
    for (let i = 0; flat && i + 1 < flat.length; i += 2) { try { o[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) { /* 무시 */ } }
    return o;
  } catch (e) { return {}; }
}
function monthsBack(n) { // 한국시간 기준 이번 달부터 n개월 전까지 ["YYYY-MM", …]
  const t = usage.kstDate(), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7)), out = [];
  for (let i = 0; i < n; i++) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); out.push(d.toISOString().slice(0, 7)); }
  return out;
}
const nextMonth = mo => { const d = new Date(Date.UTC(Number(mo.slice(0, 4)), Number(mo.slice(5, 7)), 1)); return d.toISOString().slice(0, 7); };

// 날짜별: Nimble은 회사 API의 일별(UTC) 키별 요청, Tavily는 저장한 누적값의 전날 대비 차(저장 시작 전 날짜는 비어 있음)
async function daily() {
  const [cur, prev] = monthsBack(2);
  const kk = keyKinds(), byDay = {};
  const row = d => byDay[d] || (byDay[d] = { "날짜": d, "Tavily 누적": null, "Tavily": null, "Nimble": 0, "Nimble 커넥터 직접": 0, "Nimble 전용 키": 0, "Nimble 본인 키": 0 });
  let nbNote = "";
  try {
    const r = await nimbleRows([["start", `${prev}-01T00:00:00Z`], ["group_by", "time"], ["group_by", "api_key"], ["granularity", "day"]]);
    for (const x of r.rows) {
      const d = String(x.timestamp || "").slice(0, 10); if (!d) continue;
      const n0 = Number((x.metrics || {}).requests) || 0, id = (x.dimensions || {}).api_key || null, o = row(d);
      o["Nimble"] += n0;
      if (!id) o["Nimble 커넥터 직접"] += n0; else if (id === kk.own) o["Nimble 전용 키"] += n0; else if (id === kk.personal) o["Nimble 본인 키"] += n0;
    }
    if (r.meta.partial) nbNote = "Nimble 최근 몇 시간은 집계 중";
  } catch (e) { nbNote = `Nimble 조회 실패: ${e.message}`; }
  const snaps = Object.assign({}, await readSnapshots(prev), await readSnapshots(cur));
  const days = Object.keys(snaps).sort();
  days.forEach((d, i) => {
    const t = snaps[d].tavily; if (!t || t.total === null || t.total === undefined) return;
    const o = row(d); o["Tavily 누적"] = t.total; o["저장 시각"] = snaps[d].at || null;
    const pd = days[i - 1], pt = pd && snaps[pd].tavily;
    if (d.slice(8) === "01") o["Tavily"] = t.total; // 1일은 주기 초기화 직후라 누적값이 그날 사용
    else if (pt && pd.slice(0, 7) === d.slice(0, 7) && Date.parse(d) - Date.parse(pd) === 86400000) o["Tavily"] = Math.max(0, t.total - pt.total);
  });
  const rows = Object.values(byDay).sort((a, b) => (a["날짜"] < b["날짜"] ? -1 : 1));
  return { rows, note: nbNote, from: `${prev}-01` };
}

// 월별: Tavily는 그 달 마지막 저장값(달이 끝나기 전이면 지금까지), Nimble은 회사 API의 그 달 키별 합계
async function monthly(n) {
  const kk = keyKinds(), rows = [];
  for (const mo of monthsBack(n || 3)) {
    const o = { "월": mo, "Tavily": null, "Tavily 커넥터 직접": null, "Tavily 전용 키": null, "Tavily 종량제": null, "Tavily 기준일": null, "Nimble": null, "Nimble 커넥터 직접": null, "Nimble 전용 키": null, "Nimble 본인 키": null, "Nimble 비용(USD)": null };
    const snaps = await readSnapshots(mo), last = Object.keys(snaps).filter(d => snaps[d].tavily).sort().pop();
    if (last) { const t = snaps[last].tavily; Object.assign(o, { "Tavily": t.total, "Tavily 전용 키": t.key, "Tavily 커넥터 직접": t.total === null || t.key === null ? null : Math.max(0, t.total - t.key), "Tavily 종량제": t.paygo, "Tavily 기준일": last }); }
    try {
      const r = await nimbleRows([["start", `${mo}-01T00:00:00Z`], ["end", `${nextMonth(mo)}-01T00:00:00Z`], ["group_by", "api_key"]]);
      let a = 0, own = 0, per = 0, none = 0;
      for (const x of r.rows) { const v = Number((x.metrics || {}).requests) || 0, id = (x.dimensions || {}).api_key || null; a += v; if (!id) none += v; else if (id === kk.own) own += v; else if (id === kk.personal) per += v; }
      Object.assign(o, { "Nimble": a, "Nimble 커넥터 직접": none, "Nimble 전용 키": own, "Nimble 본인 키": per, "Nimble 비용(USD)": r.totals.cost_usd ?? null });
    } catch (e) { /* 범위 밖(90일 넘음) 등은 비워 둔다 */ }
    rows.push(o);
  }
  return { rows };
}

const fmt = v => (v === null || v === undefined ? "-" : Number(v).toLocaleString("en-US"));
async function report(args) {
  const view = (args && args.view) || "current";
  if (view === "daily") {
    const d = await daily();
    const L = [`Tavily·Nimble 날짜별 사용 (${d.from}부터) — Nimble은 회사 집계(UTC 날짜), Tavily는 날마다 저장한 누적값의 전날 대비 차(저장 시작 전 날짜는 '-')${d.note ? ` · ${d.note}` : ""}`, "", "| 날짜 | Tavily(크레딧) | Nimble(요청) | Nimble 커넥터 직접 | Nimble 전용 키 | Nimble 본인 키 |", "|---|---:|---:|---:|---:|---:|"];
    d.rows.forEach(r => L.push(`| ${r["날짜"]} | ${fmt(r["Tavily"])} | ${fmt(r["Nimble"])} | ${fmt(r["Nimble 커넥터 직접"])} | ${fmt(r["Nimble 전용 키"])} | ${fmt(r["Nimble 본인 키"])} |`));
    return { content: [{ type: "text", text: L.join("\n") }], structuredContent: { view, rows: d.rows, note: d.note } };
  }
  if (view === "monthly") {
    const m = await monthly(Number(args && args.months) || 3);
    const L = ["Tavily·Nimble 월별 사용 — Tavily는 그 달 마지막 저장값(크레딧, 저장 시작 전 달은 '-'), Nimble은 회사 집계(요청, UTC 달)", "", "| 월 | Tavily | Tavily 커넥터 직접 | Tavily 전용 키 | Tavily 종량제 | Nimble | Nimble 커넥터 직접 | Nimble 전용 키 | Nimble 본인 키 | Nimble 비용(USD) |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
    m.rows.forEach(r => L.push(`| ${r["월"]} | ${fmt(r["Tavily"])} | ${fmt(r["Tavily 커넥터 직접"])} | ${fmt(r["Tavily 전용 키"])} | ${fmt(r["Tavily 종량제"])} | ${fmt(r["Nimble"])} | ${fmt(r["Nimble 커넥터 직접"])} | ${fmt(r["Nimble 전용 키"])} | ${fmt(r["Nimble 본인 키"])} | ${r["Nimble 비용(USD)"] ?? "-"} |`));
    return { content: [{ type: "text", text: L.join("\n") }], structuredContent: { view, rows: m.rows } };
  }
  const [paths, own] = await Promise.all([pathCounts().catch(() => ({ account: {}, agent: {} })), ownNimbleMonth()]);
  const [tv, nb] = await Promise.all([tavily(), nimble(own)]);
  await saveSnapshot(tv, nb);
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
    L.push(`| 계정 전체 | ${fmt(nb.total)} | 무료 제공은 처음 5,000건(누적) 기준${nb.cost_usd !== null ? `, 과금 기준 비용 $${nb.cost_usd}` : ""} |`);
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
    rows.push({ "서비스": "Nimble", "구분": "계정 전체", "사용량": t, "단위": "요청", "비중": 1, "비고": `무료 제공 처음 5,000건(누적) · ${base}` });
    rows.push({ "서비스": "Nimble", "구분": "웹 도구 서버(전용 키)", "사용량": nb.server, "단위": "요청", "비중": share(nb.server, t), "비고": `${nb.server_key_guessed ? "키 id 추정 · " : ""}이번 달 호출 계정 경로 ${nbAcc}·업무 에이전트 경로 ${nbAg}` });
    if (nb.personal || process.env.NIMBLE_PERSONAL_KEY_ID) rows.push({ "서비스": "Nimble", "구분": "사용자 본인 키(다른 자체 서버)", "사용량": nb.personal, "단위": "요청", "비중": share(nb.personal, t), "비고": "공공데이터 등 서버의 국내 접속 대행" });
    rows.push({ "서비스": "Nimble", "구분": "키 없는 요청(커넥터 직접 호출 등)", "사용량": nb.keyless, "단위": "요청", "비중": share(nb.keyless, t), "비고": "계정 채팅의 Nimble 커넥터·Nimble 대시보드" });
    if (nb.other) rows.push({ "서비스": "Nimble", "구분": "그 밖의 키", "사용량": nb.other, "단위": "요청", "비중": share(nb.other, t), "비고": "" });
  }
  // ---- 과금 관리용(2026-11-09 사용자 요청): 서비스별 이번 달 합계·무료 제공 대비·월말 추정, 그리고 출처별 내역(행을 더하면 계정 전체)
  const kst = new Date(Date.now() + 9 * 3600e3), dayNo = kst.getUTCDate(), monthDays = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() + 1, 0)).getUTCDate();
  const proj = v => (v === null || v === undefined ? null : Math.round(v / dayNo * monthDays));
  const NB_FREE = Number(process.env.NIMBLE_FREE_TOTAL || process.env.NIMBLE_FREE_MONTHLY) || 5000;
  const nbMonthly = process.env.NIMBLE_FREE_MODE === "monthly";
  const cum = nb.error || nbMonthly ? null : await nimbleCumulative();
  const nbCum = cum && !cum.error ? cum.prev + nb.total : null;
  const month = usage.kstDate().slice(0, 7);
  const summary = [];
  if (!tv.error) summary.push({ "서비스": "Tavily", "단위": "크레딧", "이번 달 사용": tv.account.total, "무료 제공": tv.account.plan_limit, "사용률": tv.account.plan_limit ? Math.round((tv.account.plan_usage || 0) / tv.account.plan_limit * 1000) / 1000 : null, "과금 사용": tv.account.paygo_usage, "과금 한도": tv.account.paygo_limit, "과금 표시": `종량제 ${fmt(tv.account.paygo_usage)} / ${fmt(tv.account.paygo_limit)} 크레딧`, "월말 추정": proj(tv.account.total), "무료 방식": "매월", "누적 사용": null, "월말 누적 추정": null, "기준": `${month} 청구 주기 — 무료 1,000크레딧은 매월 새로 주어짐` });
  if (!nb.error) {
    const base = nbCum === null ? nb.total : nbCum, endCum = nbCum === null ? proj(nb.total) : nbCum - nb.total + proj(nb.total);
    summary.push({ "서비스": "Nimble", "단위": "요청", "이번 달 사용": nb.total, "무료 제공": NB_FREE, "무료 방식": nbCum === null ? (nbMonthly ? "매월" : "누적(조회 실패 — 이번 달 기준)") : "누적", "누적 사용": nbCum, "사용률": Math.round(base / NB_FREE * 1000) / 1000, "과금 사용": Math.max(0, base - NB_FREE), "과금 한도": null, "과금 표시": nb.cost_usd === null ? "무료 제공 초과분" : `Nimble 산정 비용 $${nb.cost_usd}(이번 달)`, "월말 추정": proj(nb.total), "월말 누적 추정": nbCum === null ? null : endCum, "기준": `${month} (UTC)${nb.partial ? " · 최근 몇 시간 집계 중" : ""}${nbCum === null ? "" : ` · 누적은 ${String(cum.since).slice(0, 7)}부터 회사 집계 합`}` });
  }
  const sources = [];
  const val = (b, a, c) => (b ? (b[a] || 0) + (b[c] || 0) : 0);
  const add = (o) => sources.push(Object.assign({ "키": `${o["경로"]}|${o["사용자"] || "-"}` }, o));
  if (!tv.error || !nb.error) add({ "경로": "계정 채팅 — Tavily·Nimble 커넥터 직접 호출", "사용자": "(계정)", "Tavily": tv.error ? null : tv.other, "Nimble": nb.error ? null : nb.keyless, "비고": "회사 집계에서 다른 출처를 뺀 값(Tavily는 크레딧). Nimble은 Nimble 대시보드에서 쓴 것도 포함" });
  const logTv = { n: 0 }, logNb = { n: 0 };
  Object.keys(paths.by).sort().forEach(k => {
    const i = k.indexOf("|"), ch = k.slice(0, i), caller = k.slice(i + 1), b = paths.by[k];
    const t = val(b, "tavily.search", "tavily.extract"), m = val(b, "nimble.search", "nimble.extract");
    if (!t && !m) return;
    logTv.n += t; logNb.n += m;
    add({ "경로": ch === "agent" ? "업무 에이전트" : "계정 채팅 — 웹 도구 커넥터", "사용자": caller, "Tavily": t, "Nimble": m, "비고": `Tavily 검색 ${b["tavily.search"] || 0}·읽기 ${b["tavily.extract"] || 0}, Nimble 검색 ${b["nimble.search"] || 0}·읽기 ${b["nimble.extract"] || 0}건(요청 수)` });
  });
  if (!nb.error && nb.personal) add({ "경로": "다른 자체 서버 — 본인 키", "사용자": "(계정)", "Tavily": 0, "Nimble": nb.personal, "비고": "공공데이터 등 서버의 국내 접속 대행" });
  const restTv = tv.error ? null : Math.max(0, (tv.key.usage || 0) - logTv.n), restNb = nb.error ? null : Math.max(0, (nb.server || 0) - logNb.n);
  if (restTv || restNb) add({ "경로": "웹 도구 서버 — 경로를 나누지 못한 몫", "사용자": "-", "Tavily": restTv, "Nimble": restNb, "비고": "경로 기록 시작(2026-11-07) 전 사용, Tavily 심화 검색·읽기의 크레딧 차이, 월 경계 차이(Nimble UTC·기록 한국시간) 등" });
  if (!nb.error && nb.other) add({ "경로": "그 밖의 키", "사용자": "-", "Tavily": 0, "Nimble": nb.other, "비고": "" });
  add({ "경로": "계정 전체(회사 집계)", "사용자": "합계", "Tavily": tv.error ? null : tv.account.total, "Nimble": nb.error ? null : nb.total, "비고": "위 행들의 합. 회사 집계가 몇 시간 늦어 웹 도구 서버 기록이 먼저 잡히면 합이 조금 넘을 수 있음" });
  return {
    content: [{ type: "text", text: L.join("\n") }],
    structuredContent: { rows, summary, sources, month, tavily: tv, nimble: nb, paths: { tavily: { account: tvAcc, agent: tvAg }, nimble: { account: nbAcc, agent: nbAg } }, server_nimble_month_counter: own }
  };
}

// 예약 실행용: 오늘 값을 저장만 한다
async function snapshotJob() {
  const own = await ownNimbleMonth();
  const [tv, nb] = await Promise.all([tavily(), nimble(own)]);
  const ok = await saveSnapshot(tv, nb);
  return { ok, day: usage.kstDate(), tavily: tv.error || (tv.account && tv.account.total), nimble: nb.error || nb.total };
}

const TOOL = {
  name: "web_vendor_usage",
  description: "관리자 전용: Tavily·Nimble 회사가 집계한 사용량을 계정 전체·이 서버 전용 키·그 밖(커넥터 직접 호출 등)으로 나눠 보여 준다(view: 이번 달·날짜별·월별). Tavily는 크레딧, Nimble은 요청 수 단위.",
  inputSchema: { type: "object", properties: {
    view: { type: "string", enum: ["current", "daily", "monthly"], description: "current(기본): 이번 달 합계·출처별 / daily: 지난달 1일부터 날짜별 / monthly: 월별 합계" },
    months: { type: "integer", minimum: 1, maximum: 13, description: "monthly에서 볼 달 수(기본 3, Nimble은 회사 API가 약 90일 안만 줌)" }
  }, additionalProperties: false }
};
module.exports = { TOOL, report, snapshotJob, _test: { tavily, nimble, pathCounts, daily, monthly, saveSnapshot } };
