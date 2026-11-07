// 웹 도구 — 일반 웹 검색(web_search)과 웹페이지 본문 읽기(fetch_page).
// 계정 커넥터와 업무 에이전트 중계 서버(agent-relay-mcp)가 함께 쓴다. 중계 서버를 내려도 이 서버는 남는다.
//
// 아래 순서로 시도한다.
//   fetch_page : 직접 접속(무료) → Nimble extract(국내 IP·브라우저 렌더, 월 상한) → Tavily extract(월 무료 크레딧).
//                direct_only=true면 직접 접속만(대체 경로 생략).
//                HTML은 lib/html.js(실제 HTML 파서, 기사 본문 고르기, 표, 페이지 내장 데이터), 본문이 비면 같은 사이트 iframe을 한 번 따라감.
//                첨부(PDF·DOCX·XLSX·PPTX·HWP·HWPX)는 직접 받아 서버에서 글로 바꾼다(lib/docs.js·lib/hwp.js).
//                글자가 없는 스캔 PDF만 대체 경로(Tavily — Nimble은 파일을 글로 바꾸지 않음)로 넘긴다.
//   web_search : Tavily search(월 무료 크레딧) → Nimble search(lite, 유료). engine="nimble"이면 Nimble부터(공식 원문 찾기),
//                depth="advanced"면 Tavily 심화 검색. Nimble 검색은 한글 질의·region=kr이면 국내 접속(KR·ko)으로 부른다.
// 네이버 검색은 별도 도구(search_naver)이고, 국내 자료는 그쪽이 먼저다(에이전트 지침).
//
// 지키는 것
//   - robots.txt가 막은 주소는 어떤 경로로도 읽지 않는다(대신 읽어 주는 외부 서비스로 우회하지 않음).
//   - 사설망·루프백·메타데이터 주소는 열지 않는다(DNS 해석 결과까지 확인, 리다이렉트마다 다시 확인).
//   - 돈이 드는 경로만 한도로 센다: 사람별 하루 검색·대체 경로 읽기, 서버 전체 월 Nimble 요청.
//   - 직접 읽기·HWP 읽기는 횟수로 세지 않는다(2026-10-24 사용자 결정 — 정상적으로 여러 번 쓰는 것은 막지 않는다).
//     비정상 호출만 막는다: ① 같은 사람이 같은 주소·같은 위치를 짧은 시간에 되풀이(에이전트 반복 호출)
//     ② 에이전트 사용자 한 명이 1분에 수십 번을 넘게 부르는 폭주. 계정 키(WEB_BURST_EXEMPT)는 ②를 적용하지 않는다.
//   - 계정 키(WEB_DAILY_EXEMPT)는 사람별 하루 한도(검색·대체 경로 읽기)를 적용하지 않는다(2026-10-24 사용자 결정 —
//     계정은 서버 전체 월 한도를 다 쓸 수 있다. 다 쓰면 에이전트 사용자도 그달은 막힌다). 횟수는 그대로 센다.
//
// 환경변수: TAVILY_API_KEY, NIMBLE_API_KEY,
//   WEB_SEARCH_DAILY(기본 60) · WEB_PAID_FETCH_DAILY(기본 40) — 사람별 하루
//   WEB_DAILY_EXEMPT(기본 "koo") — 위 하루 한도를 적용하지 않는 키 식별자(쉼표 구분)
//   NIMBLE_MONTHLY_MAX(기본 5000 — Nimble 무료 제공 5,000페이지 기준, 유료 전환 후에도 예산 범위 내) — 이 서버 전체 월 Nimble 요청 수
//   WEB_REPEAT_MAX(기본 5) · WEB_REPEAT_WINDOW_SEC(기본 600) — 같은 주소·같은 위치 반복 허용 횟수와 창
//   WEB_BURST_PER_MIN(기본 60) — 사람별 1분 호출 상한, WEB_BURST_EXEMPT(기본 "koo") — 이 상한을 적용하지 않는 키 식별자

const dns = require("dns").promises;
const net = require("net");
const usage = require("./usage");
// 호출마다 누가·어느 쪽에서 불렀는지를 유료 요청 기록까지 넘기기 위한 실행 맥락
const { AsyncLocalStorage } = require("async_hooks");
const CTX = new AsyncLocalStorage();
const docs = require("./docs");
const html = require("./html");

const UA = "Mozilla/5.0 (compatible; web-reader/1.0; +https://github.com/Sejin-Koo/web-reader-mcp)";
const ROBOTS_TOKEN = "web-reader";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 첨부 파일(HWP·HWPX)
const DEFAULT_CHARS = 20000, MAX_CHARS = 60000;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = () => ({
  search: num(process.env.WEB_SEARCH_DAILY, 60),
  paidFetch: num(process.env.WEB_PAID_FETCH_DAILY, 40),
  repeatMax: num(process.env.WEB_REPEAT_MAX, 5),
  repeatWindow: num(process.env.WEB_REPEAT_WINDOW_SEC, 600),
  burst: num(process.env.WEB_BURST_PER_MIN, 60),
  nimbleMonth: num(process.env.NIMBLE_MONTHLY_MAX, 5000)
});

// ---------- 한도 카운터 ----------
function kstMonth() { return usage.kstDate().slice(0, 7); }
// 카운터를 1 올리고 한도를 넘었으면 되돌린 뒤 false. 저장소가 없거나 오류면 막지 않는다(로그만).
async function take(key, limit, ttlSec) {
  if (!usage.configured()) return true;
  try {
    const [n] = await usage.pipeline([["INCR", key], ["EXPIRE", key, String(ttlSec)]], 1500);
    if (Number(n) > limit) { await usage.pipeline([["DECR", key]], 1500); return false; }
    return true;
  } catch (e) {
    console.log(`[web] 한도 카운터 오류(통과시킴): ${e.message}`);
    return true;
  }
}
async function giveBack(key) {
  if (!usage.configured()) return;
  try { await usage.pipeline([["DECR", key]], 1500); } catch (e) { /* 무시 */ }
}
const dayKey = (kind, caller) => `w:${usage.kstDate()}:${caller}:${kind}`;
const nimbleKey = () => `w:nimble:${kstMonth()}`;
const BURST_EXEMPT = () => (process.env.WEB_BURST_EXEMPT || "koo").split(",").map(s => s.trim()).filter(Boolean);
const DAILY_EXEMPT = () => (process.env.WEB_DAILY_EXEMPT || "koo").split(",").map(s => s.trim()).filter(Boolean);
// 하루 한도: 면제 키도 카운터는 올린다(사용량 확인용, giveBack과 짝을 맞춤). 한도만 적용하지 않는다.
const dailyLimit = (kind, caller) => DAILY_EXEMPT().includes(caller) ? Number.MAX_SAFE_INTEGER : LIMITS()[kind];
function shortHash(s) { return require("crypto").createHash("sha1").update(s).digest("hex").slice(0, 16); }
// ---------- 유료 경로 결과 1시간 보관 (2026-10-31) ----------
// Nimble·Tavily로 읽은 결과는 이어 읽기(start)마다 처음부터 다시 렌더링·추출해 수 초가 걸리고 유료 횟수도
// 매번 차감됐다(실측: Nimble 첫 조회 16.1초, 이어 읽기 6.8초). 그래서 유료 경로로 얻은 본문만 한도 카운터와
// 같은 Redis에 1시간 보관해 같은 주소를 다시 읽을 때 쓴다. 직접 접속·한글 문서는 원래 1초 안팎이라 보관하지 않는다.
// 보관은 보조 장치다 — 저장소가 없거나 오류면 종전처럼 다시 읽는다. 끄려면 WEB_PAID_CACHE_DISABLED=1.
const PAID_CACHE_SEC = () => num(process.env.WEB_PAID_CACHE_SEC, 3600);
const PAID_CACHE_MAX_CHARS = 1_000_000; // 이보다 긴 본문은 보관하지 않는다(Redis 한 건 상한·공용 용량 보호)
const paidCacheOn = () => usage.configured() && process.env.WEB_PAID_CACHE_DISABLED !== "1";
const paidKey = href => `w:pc:${shortHash(href)}`;
async function paidCacheGet(href) {
  if (!paidCacheOn()) return null;
  try {
    const [v] = await usage.pipeline([["GET", paidKey(href)]], 3000);
    if (!v) return null;
    const p = JSON.parse(v);
    return p && p.href === href && typeof p.text === "string" ? p : null;
  } catch (e) { console.log(`[web] 보관본 읽기 오류(다시 읽음): ${e.message}`); return null; }
}
async function paidCacheSet(href, page) {
  if (!paidCacheOn() || !page || page.text.length > PAID_CACHE_MAX_CHARS) return;
  // 얇은 결과(메뉴·쿠키 안내만 온 경우)는 보관하지 않는다 — 1시간 동안 같은 주소의 다시 읽기를 막아 버린다(2026-11-04 실측: 유럽 집행위 연설 페이지).
  if (cleanMd(page.text).length < 500) return;
  try {
    const v = JSON.stringify({ href, savedAt: Date.now(), via: page.via, url: page.url, title: page.title || "", text: page.text });
    await usage.pipeline([["SET", paidKey(href), v, "EX", String(PAID_CACHE_SEC())]], 3000);
  } catch (e) { console.log(`[web] 보관본 저장 오류(무시): ${e.message}`); }
}

// ---------- '본문 없음' 판정의 사이트별 자동 교정 (2026-11-07) ----------
// 직접 접속 글이 짧기만 해(자바스크립트 안내 문구 없음) 유료 경로로 넘겼는데 유료 결과가 더 풍부하지 않으면 그 사이트는
// 짧은 글도 정상이라는 표시를 1 올린다. 2번 이상 쌓이고 반대 사례(유료 쪽이 확실히 더 풍부)가 없으면 이후 그 사이트의 짧은 글은
// 유료 경로 없이 직접 접속 결과를 그대로 쓴다. 반대 사례가 나오면 표시를 지우고 30일 동안 교정하지 않는다.
const OKTHIN_DAYS = 30;
const okThinKey = host => `w:okthin:${host}`;
const needJsKey = host => `w:needjs:${host}`;
async function thinVerdict(host) {
  if (!usage.configured()) return { trusted: false };
  try { const [ok, nj] = await usage.pipeline([["GET", okThinKey(host)], ["GET", needJsKey(host)]], 1500); return { trusted: !nj && Number(ok) >= 2, ok: Number(ok) || 0, needJs: !!nj }; }
  catch (e) { return { trusted: false }; }
}
async function thinLearn(host, directText, paidText) {
  if (!usage.configured() || !host) return null;
  const dl = cleanMd(directText).length, pl = cleanMd(paidText || "").length;
  // 유료 결과가 직접 결과보다 1.5배 이상 길고 300자 이상 많으면 직접 접속이 실제로 모자랐던 것
  const richer = pl >= dl * 1.5 && pl - dl >= 300;
  try {
    if (richer) { await usage.pipeline([["DEL", okThinKey(host)], ["SET", needJsKey(host), "1", "EX", String(OKTHIN_DAYS * 86400)]], 1500); return "needjs"; }
    await usage.pipeline([["INCR", okThinKey(host)], ["EXPIRE", okThinKey(host), String(OKTHIN_DAYS * 86400)]], 1500); return "ok";
  } catch (e) { return null; }
}

// 비정상 호출만 막는다. 반환값이 문자열이면 막은 사유다.
async function abnormalCall(kind, caller, sig) {
  const L = LIMITS();
  const rk = `w:rep:${kind}:${caller}:${shortHash(sig)}`;
  if (!(await take(rk, L.repeatMax, L.repeatWindow))) {
    return `같은 요청을 ${Math.round(L.repeatWindow / 60)}분 안에 ${L.repeatMax}번 넘게 되풀이했습니다. 앞에서 받은 결과를 쓰고 같은 호출을 반복하지 마세요(이어 읽기는 start를 바꿔 부르면 됩니다).`;
  }
  if (!BURST_EXEMPT().includes(caller)) {
    const minute = Math.floor(Date.now() / 60000);
    if (!(await take(`w:burst:${caller}:${minute}`, L.burst, 120))) {
      return `1분 안에 호출이 ${L.burst}번을 넘었습니다. 잠시 뒤 다시 부르세요.`;
    }
  }
  return null;
}

// ---------- 주소 안전 확인 ----------
function privateV4(ip) {
  const p = ip.split(".").map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
}
function privateIp(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const s = ip.toLowerCase();
  if (s.startsWith("::ffff:")) return privateV4(s.slice(7));
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb");
}
async function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (e) { throw new Error("주소 형식이 올바르지 않습니다"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("http·https 주소만 읽을 수 있습니다");
  if (u.username || u.password) throw new Error("계정 정보가 들어간 주소는 열지 않습니다");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error("내부 주소는 열 수 없습니다");
  if (net.isIP(host)) { if (privateIp(host)) throw new Error("내부 주소는 열 수 없습니다"); return u; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw new Error(`도메인을 찾을 수 없습니다: ${host}`); }
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error("내부 주소로 연결되는 도메인은 열 수 없습니다");
  return u;
}

// ---------- robots.txt ----------
const robotsCache = new Map(); // origin -> { at, rules }
const AI_BAN = /(retrieval[- ]augmented|\bRAG\b|AI training|LLM|생성형 ?AI|인공지능 학습)[^\n]{0,80}(prohibit|not (be )?(permitted|allowed)|forbidden|금지)/i;
function parseRobots(text) {
  // 우리 토큰 그룹이 있으면 그것, 없으면 * 그룹
  const groups = []; let cur = null, lastWasUA = false;
  String(text || "").split(/\r?\n/).forEach(line => {
    const l = line.replace(/#.*$/, "").trim();
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!lastWasUA || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasUA = true;
    } else {
      lastWasUA = false;
      if (cur && (k === "allow" || k === "disallow")) cur.rules.push({ allow: k === "allow", path: v });
    }
  });
  const mine = groups.filter(g => g.agents.some(a => a !== "*" && ROBOTS_TOKEN.includes(a)));
  const pick = mine.length ? mine : groups.filter(g => g.agents.includes("*"));
  return [].concat(...pick.map(g => g.rules)).filter(r => r.path !== "" || !r.allow);
}
function ruleMatch(rulePath, path) {
  if (rulePath === "") return false;
  const esc = rulePath.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
  return new RegExp("^" + esc).test(path);
}
async function robotsAllowed(u) {
  const origin = u.origin;
  let c = robotsCache.get(origin);
  if (!c || Date.now() - c.at > 3600 * 1000) {
    let rules = [];
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(origin + "/robots.txt", { headers: { "User-Agent": UA }, redirect: "follow", signal: ctl.signal });
      clearTimeout(t);
      if (r.ok && /text\/plain|octet-stream|^$/i.test(r.headers.get("content-type") || "")) {
        const txt = (await r.text()).slice(0, 200000);
        rules = parseRobots(txt);
        // 주석으로라도 AI 학습·검색증강(RAG) 목적의 수집을 금지한다고 밝힌 사이트는 전체를 읽지 않는다
        if (AI_BAN.test(txt)) rules = [{ allow: false, path: "/" }];
      }
      // 401·403이면 전체 금지로 보는 관례가 있으나, 많은 국내 사이트가 robots.txt 자체를 막아 두므로 허용으로 둔다
    } catch (e) { rules = []; }
    c = { at: Date.now(), rules };
    robotsCache.set(origin, c);
  }
  const path = u.pathname + u.search;
  let best = null;
  c.rules.forEach(r => {
    if (r.path === "" && !r.allow) return; // "Disallow:" 빈 값 = 전부 허용
    if (ruleMatch(r.path, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  });
  return !best || best.allow;
}

function decodeBody(buf, contentType) {
  let cs = ((contentType || "").match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) {
    const head = Buffer.from(buf.slice(0, 4096)).toString("latin1");
    cs = ((head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1]) || "utf-8";
  }
  cs = cs.toLowerCase();
  if (cs === "ks_c_5601-1987" || cs === "ksc5601" || cs === "x-windows-949" || cs === "cp949") cs = "euc-kr";
  try { return new TextDecoder(cs).decode(buf); } catch (e) { return new TextDecoder("utf-8").decode(buf); }
}

// 응답 본문을 상한까지만 받는다
async function readCapped(r, limit) {
  const reader = r.body.getReader(); const chunks = []; let size = 0, truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
      if (size > limit) { truncated = true; try { await reader.cancel(); } catch (e) {} break; }
    }
  } catch (e) { return null; }
  return { buf: Buffer.concat(chunks.map(c => Buffer.from(c))).subarray(0, limit), truncated };
}

// ---------- 직접 접속 ----------
async function directFetch(u0) {
  let u = u0;
  for (let hop = 0; hop < 6; hop++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    let r;
    try {
      r = await fetch(u.href, { redirect: "manual", signal: ctl.signal, headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" } });
    } catch (e) { clearTimeout(t); return { ok: false, why: e.name === "AbortError" ? "응답 시간 초과" : `접속 실패(${e.message})` }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      clearTimeout(t);
      u = await checkUrl(new URL(r.headers.get("location"), u).href);
      if (!(await robotsAllowed(u))) return { ok: false, robots: true, url: u.href };
      continue;
    }
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) { clearTimeout(t); return { ok: false, status: r.status, why: `HTTP ${r.status}`, url: u.href }; }
    const cd = r.headers.get("content-disposition") || "";
    let filename = "";
    { const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i); if (m) { try { filename = decodeURIComponent(m[1]); } catch (e) { filename = m[1]; } } }
    // 헤더의 날 UTF-8 바이트가 라틴 글자로 읽힌 파일명(예: korea.kr 첨부)은 UTF-8로 되돌린다
    if (/[\u0080-\u00ff]/.test(filename) && !/[^\u0000-\u00ff]/.test(filename)) { const t = Buffer.from(filename, "latin1").toString("utf8"); if (!t.includes("\ufffd")) filename = t; }
    // 첨부 파일(PDF·한글·오피스)과 이름 모를 첨부(octet-stream·attachment)는 파일로 받아 서버에서 글로 바꾼다(lib/docs.js).
    // 오피스 새 형식의 content-type에는 'xml'이 들어 있어(…officedocument.spreadsheetml…) 글 판정보다 먼저 가려야 한다.
    const nameExt = `${u.pathname} ${filename}`;
    const textCt = /html|text\/plain|json/i.test(ct);
    const pdf = /pdf/i.test(ct) || (!textCt && /\.pdf(\s|$|\?)/i.test(nameExt));
    const fileLike = pdf || /hwp|officedocument|msword|ms-excel|ms-powerpoint|opendocument/i.test(ct) || (!textCt && /\.(hwpx?|docx?|xlsx?|pptx?)(\s|$|\?)/i.test(nameExt));
    const attachment = /octet-stream|x-download|force-download|binary/i.test(ct) || /attachment/i.test(cd);
    if (fileLike || (attachment && !textCt)) {
      const got = await readCapped(r, MAX_FILE_BYTES);
      clearTimeout(t);
      if (!got) return { ok: false, pdf, why: "파일을 받다가 끊김", url: u.href };
      if (got.truncated) return { ok: false, pdf, why: `파일이 너무 큼(${Math.round(MAX_FILE_BYTES / 1048576)}MB 초과)`, url: u.href };
      return { ok: true, binary: true, pdf: pdf || docs.isPdf(got.buf), url: u.href, contentType: ct, filename, buf: got.buf };
    }
    if (!/html|text\/plain|json|xml/i.test(ct)) { clearTimeout(t); return { ok: false, why: `글로 읽을 수 없는 형식(${ct.split(";")[0] || "알 수 없음"})`, url: u.href }; }
    // 크기 상한까지만 읽는다
    const reader = r.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); size += value.length;
        if (size > MAX_BYTES) { try { await reader.cancel(); } catch (e) {} break; }
      }
    } catch (e) { clearTimeout(t); return { ok: false, why: "본문을 받다가 끊김", url: u.href }; }
    clearTimeout(t);
    const buf = new Uint8Array(size); let off = 0; chunks.forEach(c => { buf.set(c.subarray(0, Math.min(c.length, size - off)), off); off += c.length; });
    const body = decodeBody(buf, ct);
    return { ok: true, url: u.href, contentType: ct, body };
  }
  return { ok: false, why: "리다이렉트가 너무 많음" };
}

// ---------- Tavily · Nimble ----------
// 유료 요청 1건을 경로별로 센다(Tavily·Nimble 사용량을 계정·에이전트로 나눠 보기 위함, 2026-11-07)
function providerItem(url) {
  const m = String(url).match(/api\.tavily\.com\/(search|extract)|nimbleway\.com\/v2\/(search|extract)/);
  if (!m) return "";
  return m[1] ? `tavily.${m[1]}` : `nimble.${m[2]}`;
}
function countPaid(url, ok) {
  const item = providerItem(url), cx = CTX.getStore();
  if (item && cx) usage.recordPath(cx.caller, cx.channel, item, ok);
}
async function postJson(url, key, body, timeoutMs) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  let ok = false;
  try {
    const r = await fetch(url, { method: "POST", signal: ctl.signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) { /* 아래에서 처리 */ }
    if (!r.ok) {
      const msg = (j && (j.detail && (j.detail.error || j.detail) || j.error || j.message)) || text.slice(0, 200);
      const err = new Error(`HTTP ${r.status} ${typeof msg === "string" ? msg : JSON.stringify(msg)}`.slice(0, 300));
      err.status = r.status; throw err;
    }
    if (!j) throw new Error("응답이 JSON이 아닙니다");
    ok = true;
    return j;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("응답 시간 초과");
    throw e;
  } finally { clearTimeout(t); countPaid(url, ok); }
}
async function tavilyExtract(url) {
  const key = process.env.TAVILY_API_KEY; if (!key) throw new Error("Tavily 키 미설정");
  const j = await postJson("https://api.tavily.com/extract", key, { urls: [url], extract_depth: "basic", format: "markdown" }, 45000);
  const r = (j.results || [])[0];
  if (!r || !r.raw_content) throw new Error(((j.failed_results || [])[0] || {}).error || "본문을 받지 못함");
  return { text: String(r.raw_content), url: r.url || url };
}
async function nimbleExtract(url) {
  const key = process.env.NIMBLE_API_KEY; if (!key) throw new Error("Nimble 키 미설정");
  if (!(await take(nimbleKey(), LIMITS().nimbleMonth, 40 * 86400))) throw new Error("이번 달 Nimble 사용 한도에 도달");
  // 자바스크립트로 그리는 페이지는 렌더링 드라이버(vx8)가 있어야 본문이 나온다 — driver를 빼면 기본값 vx6(자바스크립트 없음)로 돌아
  // render만 켜서는 본문이 비었다(2026-11-04 실측: 유럽 집행위 연설 페이지, 계정 Nimble 도구의 driver="vx8"은 성공).
  // 첫 시도가 얇거나 비면 5초 기다렸다가 한 번 더 읽는다(문서 형식: browser_actions [{wait:"5s"}]). 실측(2026-11-04): 유럽 집행위 보도자료 ip_26_1714 — vx8만으로는 빈 본문(성공 응답), wait 5000이면 본문 전체. 은닉형 드라이버(vx10)는 쓰지 않는다.
  const body = { url, driver: "vx8", render: true, formats: ["markdown"], country: "KR", locale: "ko-KR" };
  const once = async (extra) => {
    const j = await postJson("https://sdk.nimbleway.com/v2/extract", key, Object.assign({}, body, extra || {}), 90000);
    const md = j && j.data && j.data.markdown;
    if (j.status !== "success") throw new Error(`실패(status=${j.status || "?"}, 사이트 응답 ${j.status_code || "?"})`);
    // 성공인데 본문이 비어 오는 경우가 있다(렌더 전 캡처) — 실패로 던지지 않고 빈 본문으로 돌려 아래 기다림 재시도로 넘긴다.
    return { text: String(md || ""), url: j.url || url };
  };
  try {
    const first = await once();
    if (cleanMd(first.text).length >= 200) return first;
    if (!(await take(nimbleKey(), LIMITS().nimbleMonth, 40 * 86400))) return first;
    let best = first;
    try { const second = await once({ browser_actions: [{ wait: "5s" }] }); if (cleanMd(second.text).length > cleanMd(first.text).length) best = second; }
    catch (e2) { /* 첫 결과 유지 */ }
    if (!cleanMd(best.text)) throw new Error("실패(본문 없음 — 렌더 후에도 비어 있음)");
    return best;
  } catch (e) { if (/HTTP 4\d\d|HTTP 5\d\d|시간 초과/.test(e.message)) await giveBack(nimbleKey()); throw e; }
}

function cleanMd(s) {
  return String(s || "").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\((?:[^)(]|\([^)]*\))*\)/g, "$1").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function sliceText(text, start, maxChars) {
  const total = text.length; const s = Math.min(Math.max(0, start), total);
  const part = text.slice(s, s + maxChars);
  return { part, start: s, end: s + part.length, total, next: s + part.length < total ? s + part.length : null };
}

// ---------- 도구 정의 ----------
const TOOLS = [
  {
    name: "web_search",
    description: "일반 웹 검색(국내·해외). 결과는 제목·주소·요약(본문 일부)·게시일. 국내 뉴스·블로그·카페·지식iN은 search_naver가 더 촘촘하니 먼저 쓰고, 해외·영문 자료나 네이버로 부족할 때 이 도구를 쓴다. 본문 전체가 필요하면 fetch_page로 주소를 읽는다. 사람별 하루 호출 한도가 있으니 검색어를 다듬어 꼭 필요한 만큼만 부른다.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "검색어(400자 이내). 외국 자료는 그 나라 언어로" },
      max_results: { type: "integer", minimum: 1, maximum: 10, description: "결과 수(기본 5)" },
      topic: { type: "string", enum: ["general", "news"], description: "news면 최근 기사 위주" },
      time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "기간 제한(오늘부터 거꾸로). start_date·end_date를 주면 무시" },
      start_date: { type: "string", description: "이 날짜 이후 게시·수정된 결과만(YYYY-MM-DD). 특정 기간 자료(예: 2025년 3분기 발표)를 찾을 때" },
      end_date: { type: "string", description: "이 날짜 이전 게시·수정된 결과만(YYYY-MM-DD)" },
      exact_phrase: { type: "array", items: { type: "string" }, maxItems: 3, description: "결과에 그대로 들어 있어야 할 문구(고유명사·정확한 사업명·조문 문구 등, 최대 3개). 비슷한 말·다른 표기 결과를 빼고 싶을 때" },
      region: { type: "string", enum: ["global", "kr"], description: "kr이면 한국 결과를 우선(기본 global)" },
      country: { type: "string", description: "이 나라 결과를 우선(영문 국가명, 예: japan, germany, united states). 해외 현지 자료를 찾을 때 그 나라 언어 검색어와 함께 쓴다. topic이 general일 때만 적용되고 region보다 우선" },
      engine: { type: "string", enum: ["auto", "nimble"], description: "auto(기본): Tavily 먼저, 부족하면 Nimble. nimble: Nimble 검색부터 — 기관 보도자료·회사 뉴스룸·IR 같은 공식 원문을 찾을 때 쓴다(기본 검색 결과가 기사·블로그 같은 2차 인용뿐일 때 한 번 더)" },
      depth: { type: "string", enum: ["basic", "advanced"], description: "basic(기본) 또는 advanced. 기본 검색에서 공식 원문이 잡히지 않을 때 advanced로 한 번 더 부르면 다른 결과 묶음이 온다(느리고 한도 차감은 같음). engine=auto일 때만 적용" },
      include_domains: { type: "array", items: { type: "string" }, description: "이 도메인에서만(예: [\"sec.gov\"])" },
      exclude_domains: { type: "array", items: { type: "string" } }
    }, required: ["query"] }
  },
  {
    name: "fetch_page",
    description: "웹페이지 주소 하나의 본문을 글로 읽는다(검색 결과·기사·보도자료·공지·회사 홈페이지 등). 먼저 직접 접속하고, 자바스크립트로 그리거나 접속을 막는 페이지는 대체 경로로 다시 읽는다. robots.txt가 수집을 막은 사이트는 이 도구로 읽지 않는다 — 브라우저 도구가 있으면 그 브라우저로 주소를 열어 읽고(허락을 구하지 않고 바로), 없으면 다른 공식 게시처를 찾는다. 단 네이버(뉴스·블로그·카페)는 브라우저도 안전 제한으로 열지 않으므로 브라우저를 시도하지 말고, 뉴스는 검색 결과의 언론사 원문 주소(originallink)를 이 도구로 읽는다. 첨부 파일 주소(PDF·한글 HWP·HWPX·워드 DOCX·엑셀 XLSX·파워포인트 PPTX)도 서버에서 직접 글로 바꿔 준다(표는 마크다운 표, PDF 표는 테두리선으로 칸을 복원하고 확실하지 않은 표는 [표 확인 필요]로 표시 — 그 표는 pdf_pages(또는 주소 끝 #page=N)로 쪽 그림을 받아 확인, 배포용·암호 문서·구형 doc·xls는 제외, 글자 없는 스캔 PDF만 대체 경로). 기사는 본문만 골라 준다. 긴 본문은 start로 이어 읽는다. links=true면 페이지 안 링크 목록(최대 80개)도 준다(게시판 목록에서 글 주소를 찾을 때).",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "http·https 주소" },
      start: { type: "integer", minimum: 0, description: "이어 읽을 글자 위치(앞 결과의 next_start)" },
      max_chars: { type: "integer", minimum: 1000, maximum: MAX_CHARS, description: `한 번에 받을 글자 수(기본 ${DEFAULT_CHARS})` },
      links: { type: "boolean", description: "페이지 안 링크 목록도 받기" },
      direct_only: { type: "boolean", description: "true면 직접 접속만 하고 대체 경로(브라우저 렌더·추출, 유료·한도 차감)는 쓰지 않는다. 직접 읽지 못하면 실패를 돌려준다" },
      pdf_pages: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 3, description: "PDF 주소에서 이 쪽들(최대 3)을 그림(PNG)으로 받는다. 글 결과에 [표 확인 필요]가 붙은 표를 눈으로 확인할 때 쓴다. 그림을 볼 수 없는 환경이면 쓰지 않는다" }
    }, required: ["url"] }
  }
];
const NAMES = TOOLS.map(t => t.name);

function textResult(text, structured, isError) {
  const r = { content: [{ type: "text", text }] };
  if (structured) r.structuredContent = structured;
  if (isError) r.isError = true;
  return r;
}

// ---------- 검색 결과 관련성 점검 ----------
// 한글 질의에서 country를 주지 않으면 질의와 무관한 결과(예: 기준금리 질의에 관광 사이트 8건)가 오는 일이 있다(2026-10-31 실측 1건).
// 결과 제목·요약에 질의 단어가 하나라도 있는 비율이 낮으면 이상 결과로 보고 한 번씩 다시 검색한다.
// country 기본값을 바꾸지 않는 이유: 한글로 묻는 해외 주제의 현지 1차 출처가 밀려날 수 있다.
const REL_MIN = 0.4;
// Nimble 검색의 country는 두 글자 코드(Tavily는 영문 국가명). 자주 쓰는 나라만 바꾼다 — 없으면 지정하지 않는다
const NIMBLE_CC = { "south korea": "KR", korea: "KR", japan: "JP", china: "CN", taiwan: "TW", "hong kong": "HK", singapore: "SG", vietnam: "VN", india: "IN", indonesia: "ID", thailand: "TH", "united states": "US", canada: "CA", "united kingdom": "GB", germany: "DE", france: "FR", italy: "IT", spain: "ES", netherlands: "NL", australia: "AU" };
const NIMBLE_LOCALE = { KR: "ko", JP: "ja", CN: "zh", TW: "zh", DE: "de", FR: "fr", IT: "it", ES: "es", NL: "nl", VN: "vi", TH: "th", ID: "id" };
const SCORE_MIN = 0.4; // Tavily 관련도 점수 기준(2026-10-31 정상 질의 12개는 최고 0.78 이상, 대상이 없는 질의 일부는 0.35 미만 — 잠정값)
function queryTerms(q) {
  const out = [];
  for (const w of String(q).toLowerCase().match(/[가-힣a-z0-9.\-]+/g) || []) {
    if (w.length < 2) continue;
    if (/^\d+$/.test(w) || /^(19|20)\d\d년?$/.test(w) || /^\d{1,2}(월|일|분기|차)$/.test(w)) continue;
    out.push(w);
  }
  return [...new Set(out)];
}
function relevance(q, results) {
  const terms = queryTerms(q);
  if (!terms.length) return { ratio: 1, hits: results.length, total: results.length, terms: 0 };
  let hits = 0;
  for (const r of results) {
    const t = `${r.title} ${r.snippet}`.toLowerCase();
    if (terms.some(w => t.includes(w) || (w.length >= 3 && /[가-힣]$/.test(w) && t.includes(w.slice(0, -1))))) hits++;
  }
  return { ratio: results.length ? hits / results.length : 0, hits, total: results.length, terms: terms.length };
}
// 결과 하나가 질의 단어를 가장 많이 담은 비율(0~1). 단어가 여러 결과에 흩어져 있는 경우는 인정하지 않는다
const COV_MIN = 0.7; // 2026-10-31 시험: 정상 질의 12개 최저 0.75, 대상 없는 질의 6개 중 5개 0.6 이하(잠정값)
function bestCoverage(q, results) {
  const terms = queryTerms(q);
  if (!terms.length) return 1;
  let best = 0;
  for (const r of results) {
    const t = `${r.title} ${r.snippet}`.toLowerCase();
    const hit = terms.filter(w => t.includes(w) || (w.length >= 3 && /[가-힣]$/.test(w) && t.includes(w.slice(0, -1)))).length;
    best = Math.max(best, hit / terms.length);
  }
  return best;
}
function hangulDominant(q) {
  const h = (String(q).match(/[가-힣]/g) || []).length, l = (String(q).match(/[a-zA-Z]/g) || []).length;
  return h > 0 && h >= l;
}

async function webSearch(a, caller) {
  const q = String(a.query || "").trim().slice(0, 400);
  if (!q) return textResult("query가 비어 있습니다", null, true);
  if (!(await take(dayKey("search", caller), dailyLimit("search", caller), 2 * 86400))) {
    return textResult(`오늘 웹 검색 한도(${LIMITS().search}회)를 다 썼습니다. 네이버 검색(search_naver)이나 이미 찾은 주소의 본문 읽기(fetch_page)로 이어 가세요.`, null, true);
  }
  const n = Math.min(10, Math.max(1, Math.round(Number(a.max_results) || 5)));
  const topic = a.topic === "news" ? "news" : "general";
  const okDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !isNaN(Date.parse(v.trim())) ? v.trim() : "";
  const sd = okDate(a.start_date), ed = okDate(a.end_date);
  if ((a.start_date && !sd) || (a.end_date && !ed)) return textResult("start_date·end_date는 YYYY-MM-DD 형식으로 주세요(예: 2026-07-01)", null, true);
  if (sd && ed && sd > ed) return textResult(`start_date(${sd})가 end_date(${ed})보다 늦습니다`, null, true);
  const tr = !sd && !ed && ["day", "week", "month", "year"].includes(a.time_range) ? a.time_range : undefined;
  const phrases = Array.isArray(a.exact_phrase) ? a.exact_phrase.map(x => String(x).replace(/["“”]/g, "").trim()).filter(Boolean).slice(0, 3) : [];
  const inc = Array.isArray(a.include_domains) ? a.include_domains.map(String).slice(0, 20) : undefined;
  const exc = Array.isArray(a.exclude_domains) ? a.exclude_domains.map(String).slice(0, 20) : undefined;
  const notes = [];
  // 정확한 문구: 검색어에 따옴표로 넣는다(이미 들어 있으면 그대로)
  const qx = phrases.reduce((acc, p) => (acc.includes(p) ? acc.replace(p, `"${p}"`).replace(/""+/g, '"') : `${acc} "${p}"`), q).slice(0, 400);
  let results = null, via = "";
  const ctryArg = typeof a.country === "string" ? a.country.trim().toLowerCase().slice(0, 40) : "";
  const depth = a.depth === "advanced" ? "advanced" : "basic";
  const engine = a.engine === "nimble" ? "nimble" : "auto";
  // Nimble 검색은 기본 접속 국가가 미국이라 한글 질의에서 미국·작년 자료가 1위로 오는 일이 있었다(2026-11-03 실측 3건,
  // 국가·언어를 지정하자 해결). 한글 질의·region=kr이면 국내 접속, country를 주면 그 나라 코드로 부른다.
  const nimbleBody = () => {
    const body = { query: qx, max_results: n, search_depth: "lite" };
    if (tr) body.time_range = tr;
    if (sd) body.start_date = sd;
    if (ed) body.end_date = ed;
    if (topic === "news") body.focus = "news";
    if (inc && inc.length) body.include_domains = inc;
    if (exc && exc.length) body.exclude_domains = exc;
    const cc = ctryArg ? NIMBLE_CC[ctryArg] : (a.region === "kr" || hangulDominant(q) ? "KR" : "");
    if (cc) { body.country = cc; if (NIMBLE_LOCALE[cc]) body.locale = NIMBLE_LOCALE[cc]; }
    return body;
  };
  const tavily = async (ctry) => {
    const body = { query: qx, search_depth: depth, max_results: n, topic, include_published_date: true };
    if (tr) body.time_range = tr;
    if (sd) body.start_date = sd;
    if (ed) body.end_date = ed;
    if (phrases.length) body.exact_match = true;
    if (inc && inc.length) body.include_domains = inc;
    if (exc && exc.length) body.exclude_domains = exc;
    if (topic === "general") {
      if (ctry) body.country = ctry;
      else if (a.region === "kr") body.country = "south korea";
    }
    const j = await postJson("https://api.tavily.com/search", process.env.TAVILY_API_KEY, body, 30000);
    return (j.results || []).map(r => ({ title: r.title || "", url: r.url || "", snippet: String(r.content || "").slice(0, 700), published: r.published_date || "", score: typeof r.score === "number" ? Math.round(r.score * 100) / 100 : undefined }));
  };
  let rel = null;
  if (process.env.TAVILY_API_KEY && engine === "auto") {
    try {
      results = await tavily(ctryArg);
      via = "tavily";
      rel = relevance(q, results);
      // 이상 결과면 한 번 더: 한글 질의이고 country를 주지 않았으면 한국 우선으로
      if (rel.ratio < REL_MIN && topic === "general" && !ctryArg && a.region !== "kr" && hangulDominant(q)) {
        try {
          const r2 = await tavily("south korea");
          const rel2 = relevance(q, r2);
          notes.push(`질의와 무관한 결과가 많아(${rel.hits}/${rel.total}) country=south korea로 다시 검색: ${rel2.hits}/${rel2.total}`);
          console.log(`[web] 무관 결과 재검색 ${rel.hits}/${rel.total} -> ${rel2.hits}/${rel2.total}`);
          if (rel2.ratio > rel.ratio) { results = r2; rel = rel2; via = "tavily(country=south korea)"; }
        } catch (e) { notes.push(`재검색 실패: ${e.message}`); }
      }
    } catch (e) { notes.push(`1차 검색 실패: ${e.message}`); console.log(`[web] tavily search 실패: ${e.message}`); }
  }
  // Nimble 검색(공통): 한도를 먼저 세고, 실패하면 돌려준다
  let nimbleDone = false;
  const nimbleSearch = async () => {
    nimbleDone = true;
    if (!process.env.NIMBLE_API_KEY || !(await take(nimbleKey(), LIMITS().nimbleMonth, 40 * 86400))) return null;
    try {
      const j = await postJson("https://sdk.nimbleway.com/v2/search", process.env.NIMBLE_API_KEY, nimbleBody(), 40000);
      return (j.results || []).map(r => ({ title: r.title || "", url: r.url || "", snippet: String(r.description || r.content || "").slice(0, 700), published: (r.metadata && r.metadata.date) || "" }));
    } catch (e) { await giveBack(nimbleKey()); notes.push(`2차 검색 실패: ${e.message}`); return null; }
  };
  // ① 질의 단어가 거의 없는 결과면 Nimble 결과와 견줘 더 관련 있는 쪽을 쓴다
  if (results && rel && rel.ratio < REL_MIN) {
    const r3 = await nimbleSearch();
    if (r3) {
      const rel3 = relevance(q, r3);
      notes.push(`그래도 무관 결과가 많아(${rel.hits}/${rel.total}) 2차 검색 시도: ${rel3.hits}/${rel3.total}`);
      if (rel3.ratio > rel.ratio) { results = r3; rel = rel3; via = "nimble"; }
    }
  }
  // ② Tavily 관련도 점수가 낮으면(최고 SCORE_MIN 미만) Nimble 결과를 함께 싣는다(주소 중복 제거)
  const scores = via.startsWith("tavily") && results ? results.map(r => r.score).filter(x => typeof x === "number") : [];
  const maxScore = scores.length ? Math.max(...scores) : null;
  let merged = false;
  let scoreWarn = maxScore !== null && maxScore < SCORE_MIN; // Nimble 결과가 질의에 맞아 보이면 해제
  if (scoreWarn && !nimbleDone) {
    const r4 = await nimbleSearch();
    if (r4) {
      const seen = new Set(results.map(r => r.url));
      const add = r4.filter(r => r.url && !seen.has(r.url)).map(r => ({ ...r, engine: "nimble" }));
      results = results.concat(add);
      merged = add.length > 0;
      const covN = merged ? bestCoverage(q, add) : 0;
      if (merged && covN >= COV_MIN) scoreWarn = false;
      notes.push(`Tavily 관련도 최고 ${maxScore}로 낮아 Nimble 결과 ${add.length}건을 함께 실음(한 결과가 담은 질의 단어 최대 ${Math.round(covN * 100)}%${scoreWarn ? "" : " — 맞아 보여 경고 생략"})`);
      via = via + "+nimble";
    }
  }
  if (!results && process.env.NIMBLE_API_KEY) {
    if (!(await take(nimbleKey(), LIMITS().nimbleMonth, 40 * 86400))) notes.push("이번 달 대체 검색 한도에 도달");
    else {
      try {
        const j = await postJson("https://sdk.nimbleway.com/v2/search", process.env.NIMBLE_API_KEY, nimbleBody(), 40000);
        results = (j.results || []).map(r => ({ title: r.title || "", url: r.url || "", snippet: String(r.description || r.content || "").slice(0, 700), published: (r.metadata && r.metadata.date) || "" }));
        via = "nimble";
        if (results.length) rel = relevance(q, results);
        if (engine === "nimble" && !results.length && process.env.TAVILY_API_KEY) notes.push("Nimble 결과 0건");
      } catch (e) { await giveBack(nimbleKey()); notes.push(`${engine === "nimble" ? "Nimble" : "2차"} 검색 실패: ${e.message}`); console.log(`[web] nimble search 실패: ${e.message}`); }
    }
  }
  if ((!results || !results.length) && engine === "nimble" && process.env.TAVILY_API_KEY) {
    try { results = await tavily(ctryArg); via = "tavily(Nimble 실패 대체)"; rel = relevance(q, results); }
    catch (e) { notes.push(`대체 검색 실패: ${e.message}`); }
  }
  if (!results) {
    await giveBack(dayKey("search", caller));
    const why = !process.env.TAVILY_API_KEY && !process.env.NIMBLE_API_KEY ? "웹 검색 키가 서버에 설정되지 않았습니다" : notes.join(" / ");
    return textResult(`웹 검색을 하지 못했습니다: ${why}. 네이버 검색(search_naver)으로 대신 찾으세요.`, { query: q, results: [], notes }, true);
  }
  // 기간·문구 조건 사후 점검(엔진이 조건을 무시하거나 Nimble이 지원하지 않는 경우 대비)
  if (sd || ed || phrases.length) {
    const before = results.length; let undated = 0;
    const norm = t => String(t || "").toLowerCase().replace(/\s+/g, " ");
    results = results.filter(r => {
      if (sd || ed) {
        const d = String(r.published || "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { if ((sd && d < sd) || (ed && d > ed)) return false; }
        else undated++;
      }
      if (phrases.length && r.engine === "nimble" || (phrases.length && via.startsWith("nimble"))) {
        const hay = norm(`${r.title} ${r.snippet}`);
        if (!phrases.every(p => hay.includes(norm(p)))) return false;
      }
      return true;
    });
    if (before !== results.length) notes.push(`기간·문구 조건에 맞지 않는 결과 ${before - results.length}건을 뺌`);
    if (undated) notes.push(`게시일을 알 수 없는 결과 ${undated}건은 남김(기간 안인지 원문으로 확인할 것)`);
  }
  const cond = [sd || ed ? `기간 ${sd || "…"}~${ed || "…"}` : "", phrases.length ? `정확한 문구 ${phrases.map(p => `"${p}"`).join(" ")}` : ""].filter(Boolean).join(", ");
  const lines = [`[웹 검색] ${q}${cond ? ` (${cond})` : ""} — ${results.length}건`];
  results.forEach((r, i) => lines.push(`${i + 1}. ${r.title}${r.published ? ` (${String(r.published).slice(0, 10)})` : ""}${typeof r.score === "number" ? ` [관련도 ${r.score}]` : ""}${r.engine ? ` [${r.engine}]` : ""}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ")}`));
  if (scoreWarn) lines.push(`※ 검색 엔진 관련도가 최고 ${maxScore}로 낮아 이 검색어로는 적합한 자료가 없을 수 있다.${merged ? " Nimble 결과를 함께 실었다." : ""} 질의의 고유명사가 오타·다른 표기일 수 있으니 결과에 비슷한 이름이 보이면 그 이름으로, 아니면 핵심어·표기(약칭·영문·상위 주제)를 바꿔 다시 검색하고(추가 최대 2회), 그래도 낮으면 사용자에게 묻지 말고 답에 '이 검색어들로는 적합한 자료를 찾지 못함'과 시도한 검색어를 적는다.`);
  if (notes.some(n => /기간·문구|게시일을 알 수 없는/.test(n))) lines.push(`※ ${notes.filter(n => /기간·문구|게시일을 알 수 없는/.test(n)).join(" / ")}`);
  if (!results.length && cond) lines.push("※ 조건에 맞는 결과가 없다. 기간을 넓히거나 문구를 줄여 다시 검색하고, 그래도 없으면 이 조건으로는 찾지 못했다고 쓴다(없다고 단정하지 않는다).");
  if (rel && rel.ratio < REL_MIN) lines.push(`※ 결과 ${rel.total}건 중 질의 단어가 있는 것은 ${rel.hits}건뿐이라 질문과 맞지 않을 수 있다. 검색어를 바꾸거나 country를 지정해 다시 검색하고, 그래도 없으면 '확인 못함'으로 쓴다.`);
  lines.push("요약은 본문 일부다. 수치·인용은 fetch_page로 원문을 읽고 확인한 뒤 쓴다.");
  return textResult(lines.join("\n"), { query: q, engine: via, results, notes, relevance: rel ? { hits: rel.hits, total: rel.total } : undefined, max_score: maxScore === null ? undefined : maxScore });
}

// 직접 받은 파일 → page / 실패 사유. fatal이면 대체 경로로도 못 읽는 형식이라 바로 돌려준다
async function fileFromBuf(d) {
  let f = null, err = null;
  try { f = await docs.fileToText(d.buf); } catch (e) { err = e.message; }
  const label = `${(d.contentType || "").split(";")[0] || "알 수 없음"}${d.filename ? `, ${d.filename}` : ""}`;
  if (f && f.text) return { page: { via: f.kind, url: d.url, title: d.filename || "", text: f.text, links: [], notes: f.notes || [], tableCheck: f.tableCheck } };
  if (err && d.pdf) return { why: `직접 접속: PDF를 글로 바꾸지 못함(${err})` }; // 스캔 PDF 등 — 대체 경로(Tavily)로
  if (err) return { fatal: `첨부 파일을 글로 바꾸지 못했습니다(${err}): ${d.url}. 같은 내용의 PDF·한글·문서뷰어 주소가 있으면 그쪽을 읽으세요.`, error: err };
  return { why: `직접 접속: 글로 읽을 수 없는 파일(${label})` };
}
// 같은 사이트 iframe 주소 하나를 직접 읽는다(대체 경로 없음)
async function readFrame(href) {
  let u; try { u = await checkUrl(href); } catch (e) { return { why: e.message }; }
  if (!(await robotsAllowed(u))) return { why: "robots.txt로 막힘" };
  const d = await directFetch(u);
  if (!d.ok) return { why: d.why || "읽지 못함" };
  if (d.binary) { const f = await fileFromBuf(d); return f.page ? { url: d.url, text: f.page.text } : { why: f.why || f.fatal }; }
  if (!/html|xml/i.test(d.contentType)) return { url: d.url, text: d.body.trim() };
  const h = await html.htmlToPage(d.body, d.url, false);
  return h.thin ? { why: `본문이 거의 없음(${h.text.length}자)` } : { url: d.url, text: h.text };
}

async function fetchPage(a, caller) {
  let u;
  try { u = await checkUrl(a.url); } catch (e) { return textResult(e.message, null, true); }
  if (!(await robotsAllowed(u))) {
    // 네이버는 내장 브라우저·Chrome 확장 모두 안전 제한으로 열리지 않는다(2026-11-04 실측: news.naver.com·n.news.naver.com·www.naver.com).
    // 브라우저로 보내면 헛걸음이므로 대체 안내를 준다.
    if (/(^|\.)naver\.com$/i.test(u.hostname)) {
      return textResult(`네이버(${u.hostname})는 robots.txt로 자동 수집을 막아 두어 이 도구로 읽지 않고, 내장 브라우저·Chrome 확장도 안전 제한으로 열지 않습니다. 브라우저를 시도하지 마세요. 뉴스는 search_naver 결과의 originallink(언론사 원문 주소)를 이 도구로 읽으세요. 블로그·카페 글은 검색 결과 요약만 근거로 쓰고 '원문 미확인'으로 밝히세요. Nimble·Tavily·셸·캐시·미러로 우회해 읽지는 마세요.`, { url: u.href, blocked: "robots", browser: "blocked" }, true);
    }
    return textResult(`이 사이트는 robots.txt로 자동 수집을 막아 두어 이 도구로는 읽지 않습니다: ${u.href}. 브라우저 도구(내장 브라우저·Chrome 확장)가 있으면 허락을 구하지 말고 바로 그 브라우저로 이 주소를 열어 본문을 읽으세요 — 브라우저는 자체 정책을 스스로 적용하는 정식 도구이며, 그 브라우저가 거부하면 그 답이 결론입니다. Nimble·Tavily·셸(curl)·캐시·미러로 같은 주소를 우회해 읽지는 마세요. 브라우저 도구가 없으면 같은 내용을 다룬 다른 공식 게시처를 찾고, 그래도 원문을 못 읽으면 '원문 미확인'으로 밝힌 뒤 이 주소를 사용자에게 안내해 직접 열어 보게 하세요. 검색 결과 요약만으로 원문 내용을 단정하지 마세요.`, { url: u.href, blocked: "robots" }, true);
  }
  const maxChars = Math.min(MAX_CHARS, Math.max(1000, Math.round(Number(a.max_chars) || DEFAULT_CHARS)));
  const start = Math.max(0, Math.round(Number(a.start) || 0));
  let pdfPages = Array.isArray(a.pdf_pages) ? a.pdf_pages.map(Number).filter(Number.isFinite).slice(0, 3) : [];
  // 주소 끝 #page=N(PDF 표준 쪽 지정, 쉼표로 3쪽까지)도 쪽 그림 요청으로 받는다 — 연결 화면(커넥터)이 옛 도구 정보를 들고 있어
  // pdf_pages 인자를 지워 보내는 경우가 있다(2026-11-07 실측: 계정 하위 작업 5건 모두 pdf_pages가 빠져 글만 돌아옴).
  { const m = /^#page=([\d,\s]+)$/i.exec(u.hash || ""); if (m) { if (!pdfPages.length) pdfPages = m[1].split(",").map(Number).filter(n => n >= 1).slice(0, 3); u.hash = ""; } }
  const blocked = await abnormalCall("fetch", caller, `${u.href}|${start}|${maxChars}|${a.links ? 1 : 0}|${pdfPages.join(",")}`);
  if (blocked) return textResult(blocked, { url: u.href, blocked: "abnormal" }, true);
  // PDF 쪽 그림: 표 칸을 글로 복원하지 못했을 때 그 쪽을 그림으로 받아 눈으로 확인한다(직접 접속만, 유료 경로 없음)
  if (pdfPages.length) {
    const d = await directFetch(u);
    if (d.robots) return textResult(`이동한 주소가 robots.txt로 막혀 있어 그림을 만들지 않습니다: ${d.url}`, { url: d.url, blocked: "robots" }, true);
    if (!d.ok || !d.binary || !d.pdf) return textResult(`PDF 쪽 그림을 만들지 못했습니다(${d.ok ? "PDF 파일이 아님" : d.why}). pdf_pages는 PDF 주소에만 쓴다.`, { url: u.href }, true);
    let r; try { r = await docs.renderPdfPages(d.buf, pdfPages, 1.5); } catch (e) { return textResult(`PDF 쪽 그림을 만들지 못했습니다(${e.message.slice(0, 120)}).`, { url: u.href }, true); }
    const ok = r.images.filter(i => i.png);
    const head = `[PDF 쪽 그림] ${d.filename || d.url}\n주소: ${d.url}\n전체 ${r.total}쪽 중 ${ok.map(i => i.page).join("·")}쪽 그림을 붙였다. 표는 그림의 행·열을 눈으로 따라 읽고, 글로 뽑은 결과와 다른 값이 있으면 그림을 따른다.` +
      (r.images.some(i => i.error) ? `\n${r.images.filter(i => i.error).map(i => `${i.page}쪽: ${i.error}`).join(" / ")}` : "") +
      `\n그림을 볼 수 없는 환경(업무 에이전트 등)이면 같은 게시물의 HWP·HWPX 첨부나 문서뷰어(바로보기)로 확인하고, 없으면 그 표의 수치는 '원문 표 미확인'으로 밝힌다.`;
    const content = [{ type: "text", text: head }].concat(ok.map(i => ({ type: "image", data: i.png.toString("base64"), mimeType: "image/png" })));
    return { content, structuredContent: { url: d.url, pages: ok.map(i => i.page), total_pages: r.total, text: head } };
  }
  const tried = [];
  let page = null;
  let directThin = null; // 짧기만 한 직접 접속 결과(유료 결과와 견줘 사이트별 판정을 교정)
  // 유료 경로로 읽어 둔 보관본이 있으면 다시 읽지 않는다(직접 접속이 이미 실패했던 주소다).
  const kept = await paidCacheGet(u.href);
  if (kept) page = { via: kept.via, url: kept.url, title: kept.title, text: kept.text, links: [], keptMin: Math.max(0, Math.round((Date.now() - kept.savedAt) / 60000)) };
  const d = page ? { ok: false, skipped: true } : await directFetch(u);
  if (!page && d.robots) return textResult(`이동한 주소가 robots.txt로 수집을 막아 두어 이 도구로는 읽지 않습니다: ${d.url}. 브라우저 도구가 있으면 허락을 구하지 말고 바로 그 브라우저로 이 주소를 열어 읽으세요(Nimble·Tavily·셸 우회 금지). 브라우저 도구가 없으면 다른 공식 게시처를 찾고, 못 읽으면 '원문 미확인'으로 밝혀 주소를 사용자에게 안내하세요.`, { url: d.url, blocked: "robots" }, true);
  if (page) { /* 보관본 사용 */ } else if (d.ok && d.binary) {
    const f = await fileFromBuf(d);
    if (f.page) page = f.page;
    else if (f.fatal) return textResult(f.fatal, { url: d.url, filename: d.filename, error: f.error }, true);
    else tried.push(f.why);
  } else if (d.ok) {
    if (/html|xml/i.test(d.contentType) && /<html|<body|<div|<p[\s>]|<table/i.test(d.body.slice(0, 20000))) {
      let h = null;
      try { h = await html.htmlToPage(d.body, d.url, !!a.links); } catch (e) { tried.push(`직접 접속: HTML을 글로 바꾸지 못함(${e.message.slice(0, 80)})`); }
      if (h) {
        // 본문이 비었거나 짧은데 같은 사이트 iframe에 본문이 있어 보이면 한 번 따라간다(최대 2개, robots·주소 안전 확인 동일)
        const frames = h.thin ? h.frames : (h.text.length < 1500 ? h.frames.filter(f => f.content) : []);
        for (const fr of frames.sort((x, y) => (y.content ? 1 : 0) - (x.content ? 1 : 0)).slice(0, 2)) {
          const sub = await readFrame(fr.url);
          if (sub && sub.text.length > h.text.length && sub.text.length >= 200) {
            h = Object.assign({}, h, { text: sub.text, thin: false, mode: "iframe", notes: h.notes.concat([`본문이 페이지 안 틀(iframe)에 있어 그 주소를 읽음: ${sub.url}`]), frameUrl: sub.url });
            break;
          } else if (sub && sub.why) tried.push(`틀(iframe) ${fr.url}: ${sub.why}`);
        }
        if (!h.thin) page = { via: "direct", mode: h.mode, url: d.url, title: h.title, description: h.description, published: h.published, text: h.text, links: h.links, notes: h.notes };
        else {
          let host = ""; try { host = new URL(d.url).hostname; } catch (e) { /* 무시 */ }
          const v = h.softThin && host ? await thinVerdict(host) : { trusted: false };
          if (v.trusted) page = { via: "direct", mode: h.mode, url: d.url, title: h.title, description: h.description, published: h.published, text: h.text, links: h.links, notes: h.notes.concat([`글이 짧지만 이 사이트(${host})는 짧은 글도 정상으로 확인된 이력(${v.ok}회)이 있어 직접 접속 결과를 그대로 씀 — 본문이 빠져 보이면 브라우저 도구로 확인`]) };
          else { tried.push(`직접 접속: 본문이 거의 없음(${h.text.length}자, 자바스크립트로 그리는 페이지로 보임)`); if (h.softThin && host) directThin = { host, text: h.text, h, url: d.url }; }
        }
      }
    } else {
      page = { via: "direct", url: d.url, title: "", text: d.body.trim(), links: [] };
    }
  } else tried.push(`직접 접속: ${d.why}`);

  // direct_only: 무료 직접 접속만 쓴다(계정 채팅이 공식 원문을 먼저 읽을 때 — 에이전트와 함께 쓰는 유료 한도를 줄이지 않게, 2026-11-04)
  if (!page && !d.skipped && a.direct_only) {
    return textResult(`직접 접속으로 읽지 못했습니다(${tried.join(" / ")}). 대체 경로는 쓰지 않았습니다(direct_only).`, { url: u.href, tried, direct_only: true }, true);
  }
  if (!page && !d.skipped) {
    if (!(await take(dayKey("paidfetch", caller), dailyLimit("paidFetch", caller), 2 * 86400))) {
      return textResult(`직접 읽지 못했고(${tried.join(" / ")}), 오늘 대체 경로 한도(${LIMITS().paidFetch}회)를 다 썼습니다.`, { url: u.href, tried }, true);
    }
    const target = d.url || u.href;
    // Nimble(국내 IP·브라우저 렌더)을 먼저, 그다음 Tavily. PDF는 Nimble이 파일을 글로 바꾸지 않으므로 Tavily로 바로
    if (!d.pdf) {
      try {
        const nb = await nimbleExtract(target);
        const txt = cleanMd(nb.text);
        if (txt.length >= 200) page = { via: "nimble", url: nb.url, title: "", text: txt, links: [] };
        else tried.push(`대체 경로 1: 본문이 거의 없음(${txt.length}자)`);
      } catch (e) { tried.push(`대체 경로 1: ${e.message}`); }
    }
    if (!page) {
      try {
        const t = await tavilyExtract(target);
        page = { via: "tavily", url: t.url, title: "", text: cleanMd(t.text), links: [] };
      } catch (e) { tried.push(`대체 경로 2: ${e.message}`); }
    }
    if (page) await paidCacheSet(u.href, page);
    if (directThin && !page) {
      // 대체 경로가 모두 실패하면 짧은 직접 접속 글이라도 돌려준다(판정 교정에는 쓰지 않음)
      const h = directThin.h;
      page = { via: "direct", mode: h.mode, url: directThin.url, title: h.title, description: h.description, published: h.published, text: h.text, links: h.links, notes: h.notes.concat([`글이 짧아 대체 경로로 다시 읽으려 했으나 실패해 직접 접속 결과를 씀(${tried.slice(-2).join(" / ")}) — 본문이 빠져 보이면 브라우저 도구로 확인`]) };
      await giveBack(dayKey("paidfetch", caller));
    } else if (directThin) {
      const verdict = await thinLearn(directThin.host, directThin.text, page ? page.text : "");
      // 유료 쪽이 더 풍부하지 않으면 직접 접속 글(표·링크가 살아 있음)을 쓴다
      if (verdict === "ok" && page && cleanMd(page.text).length < cleanMd(directThin.text).length * 1.5) {
        const h = directThin.h;
        page = { via: "direct", mode: h.mode, url: directThin.url, title: h.title, description: h.description, published: h.published, text: h.text, links: h.links, notes: h.notes.concat([`글이 짧아 대체 경로로도 읽어 봤으나 더 나온 내용이 없어 직접 접속 결과를 씀(이 사이트의 짧은 글 판정을 교정하는 데 기록)`]) };
      }
    }
    if (!page) {
      await giveBack(dayKey("paidfetch", caller));
      return textResult(`이 페이지를 읽지 못했습니다(${tried.join(" / ")}). 브라우저 도구(내장 브라우저·Chrome 확장)가 있으면 허락을 구하지 말고 바로 그 브라우저로 이 주소를 열어 읽으세요. 브라우저 도구가 없으면 같은 내용을 다룬 다른 공식 게시처를 찾고, 그래도 못 읽으면 '원문 미확인'으로 밝혀 주소를 사용자에게 안내하세요.`, { url: u.href, tried }, true);
    }
  }
  const s = sliceText(page.text, start, maxChars);
  const docLabel = docs.KIND_LABEL[page.via];
  const head = [`${docLabel ? `[${docLabel}]` : "[웹페이지]"} ${page.title || page.url}`, `주소: ${page.url}`];
  if (page.via === "hwp" || page.via === "hwpx" || page.via === "docx" || page.via === "xlsx" || page.via === "pptx") head.push("표는 칸 단위 마크다운 표로, 칸 안 줄바꿈은 ' / '로 바꿨습니다(병합 칸은 왼쪽 위 칸에만 글).");
  if (page.via === "pdf") {
    head.push("PDF를 서버에서 글로 바꿨습니다. 쪽은 [쪽 N]으로 나눴습니다. 테두리선이 있는 표는 칸을 복원해 마크다운 표로 냈습니다.");
    const tc = page.tableCheck;
    const unsure = tc ? [...new Set(tc.failed.map(f => f.page).concat(tc.borderless.map(b => b.page)))].sort((x, y) => x - y) : [];
    if (unsure.length) head.push(`★ 표 확인 필요 — ${unsure.join("·")}쪽의 표 ${tc.failed.length + tc.borderless.length}개는 칸을 확실히 복원하지 못해 본문에 [표 확인 필요]로 표시했습니다. 그 표의 수치·항목이 답에 필요하면 이 글로 답하지 말고 다음 순서로 확인하세요: ① 같은 게시물에 HWP·HWPX·엑셀 첨부가 있으면 그것을 fetch_page로 읽기 ② fetch_page(url, pdf_pages=[쪽 번호])로 그 쪽 그림을 받아 눈으로 읽기(최대 3쪽씩 — 도구에 pdf_pages 인자가 보이지 않으면 주소 끝에 #page=쪽번호, 여러 쪽은 #page=3,4) ③ 정부 사이트 문서뷰어(바로보기)·회사 보도자료 HTML·공시 원문(DART·SEC) 같은 다른 형식의 원문 ④ 그래도 확인 못 하면 그 수치는 '원문 표 미확인'으로 밝히기.`);
  }
  if (page.mode === "article") head.push("기사 본문만 골라 읽었습니다(메뉴·추천 기사 목록 제외).");
  (page.notes || []).forEach(n => head.push(n));
  if (page.keptMin !== undefined) head.push(`서버 보관본(${page.keptMin}분 전 ${page.via === "nimble" ? "브라우저 렌더" : "대체 경로"}로 읽음, 1시간 보관 — 다시 읽지 않아 유료 횟수를 쓰지 않았습니다)`);
  if (page.published) head.push(`게시: ${page.published}`);
  if (page.description && start === 0) head.push(`설명: ${page.description}`);
  head.push(`글자 ${s.start}~${s.end} / 전체 ${s.total}${s.next !== null ? ` — 이어 읽으려면 start=${s.next}` : ""}`);
  let text = head.join("\n") + "\n\n" + s.part;
  if (a.links && page.links && page.links.length) text += "\n\n[링크]\n" + page.links.map(l => `- ${l.text} — ${l.url}`).join("\n");
  return textResult(text, { url: page.url, title: page.title, published: page.published || "", description: start === 0 ? (page.description || "") : "", text: s.part, via: page.via, mode: page.mode || undefined, table_check: page.tableCheck ? { ok: page.tableCheck.ok, uncertain_pages: [...new Set(page.tableCheck.failed.map(f => f.page).concat(page.tableCheck.borderless.map(b => b.page)))].sort((x, y) => x - y) } : undefined, notes: page.notes && page.notes.length ? page.notes : undefined, start: s.start, end: s.end, total_chars: s.total, next_start: s.next, links: a.links ? page.links : undefined, tried: tried.length ? tried : undefined });
}

async function call(name, args, caller, channel) {
  const a = args || {};
  const cx = { caller, channel: channel === "agent" ? "agent" : "account" };
  return CTX.run(cx, async () => {
    let ok = false;
    try {
      let r;
      if (name === "web_search") r = await webSearch(a, caller);
      else if (name === "fetch_page") r = await fetchPage(a, caller);
      else throw new Error(`알 수 없는 웹 도구: ${name}`);
      ok = !(r && r.isError);
      return r;
    } finally { usage.recordPath(caller, cx.channel, `tool.${name}`, ok); }
  });
}

module.exports = { TOOLS, NAMES, call, _test: { bestCoverage, relevance, queryTerms, hangulDominant, parseRobots, ruleMatch, privateIp, decodeBody, cleanMd } };
