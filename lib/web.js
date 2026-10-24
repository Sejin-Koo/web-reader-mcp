// 웹 도구 — 일반 웹 검색(web_search)과 웹페이지 본문 읽기(fetch_page).
// 계정 커넥터와 업무 에이전트 중계 서버(agent-relay-mcp)가 함께 쓴다. 중계 서버를 내려도 이 서버는 남는다.
//
// 아래 순서로 시도한다.
//   fetch_page : 직접 접속(무료) → Nimble extract(국내 IP·브라우저 렌더, 월 상한) → Tavily extract(월 무료 크레딧). PDF는 Tavily만.
//                HWP·HWPX 첨부는 직접 받아 서버에서 글로 바꾼다(lib/hwp.js — 대체 경로는 한글 문서를 읽지 못한다)
//   web_search : Tavily search(월 무료 크레딧) → Nimble search(lite, 유료)
// 네이버 검색은 별도 도구(search_naver)이고, 국내 자료는 그쪽이 먼저다(에이전트 지침).
//
// 지키는 것
//   - robots.txt가 막은 주소는 어떤 경로로도 읽지 않는다(대신 읽어 주는 외부 서비스로 우회하지 않음).
//   - 사설망·루프백·메타데이터 주소는 열지 않는다(DNS 해석 결과까지 확인, 리다이렉트마다 다시 확인).
//   - 돈이 드는 경로만 한도로 센다: 사람별 하루 검색·대체 경로 읽기, 서버 전체 월 Nimble 요청.
//   - 직접 읽기·HWP 읽기는 횟수로 세지 않는다(2026-10-24 사용자 결정 — 정상적으로 여러 번 쓰는 것은 막지 않는다).
//     비정상 호출만 막는다: ① 같은 사람이 같은 주소·같은 위치를 짧은 시간에 되풀이(에이전트 반복 호출)
//     ② 에이전트 사용자 한 명이 1분에 수십 번을 넘게 부르는 폭주. 계정 키(WEB_BURST_EXEMPT)는 ②를 적용하지 않는다.
//
// 환경변수: TAVILY_API_KEY, NIMBLE_API_KEY,
//   WEB_SEARCH_DAILY(기본 60) · WEB_PAID_FETCH_DAILY(기본 40) — 사람별 하루
//   NIMBLE_MONTHLY_MAX(기본 1000) — 이 서버 전체 월 Nimble 요청 수
//   WEB_REPEAT_MAX(기본 5) · WEB_REPEAT_WINDOW_SEC(기본 600) — 같은 주소·같은 위치 반복 허용 횟수와 창
//   WEB_BURST_PER_MIN(기본 60) — 사람별 1분 호출 상한, WEB_BURST_EXEMPT(기본 "koo") — 이 상한을 적용하지 않는 키 식별자

const dns = require("dns").promises;
const net = require("net");
const usage = require("./usage");
const hwp = require("./hwp");

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
  nimbleMonth: num(process.env.NIMBLE_MONTHLY_MAX, 1000)
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
function shortHash(s) { return require("crypto").createHash("sha1").update(s).digest("hex").slice(0, 16); }
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

// ---------- HTML → 글 ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", middot: "·", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", copy: "©", reg: "®", trade: "™", times: "×", rarr: "→", larr: "←", laquo: "«", raquo: "»" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; } catch (x) { return ""; }
    }
    const v = ENT[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}
function metaContent(html, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : "";
}
function blockText(h) {
  h = h.replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|ul|ol|dl|dd|dt|blockquote|pre|table|thead|tbody|tfoot|figure|figcaption|main|aside|nav|form|fieldset|address)>/gi, "\n")
    .replace(/<(h[1-6])[^>]*>/gi, "\n\n## ").replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ").replace(/<\/tr>/gi, "\n").replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<img[^>]*alt="([^"]{2,80})"[^>]*>/gi, " [그림: $1] ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(h).replace(/\r\n?/g, "\n").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n")
    .replace(/^(?:[-|]\s*)+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
function htmlToText(html, base, wantLinks) {
  const title = metaContent(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)/i) || metaContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = metaContent(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i) || metaContent(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)/i);
  const published = metaContent(html, /<meta[^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time|pubdate|publishdate|date)["'][^>]*content=["']([^"']*)/i);
  let h = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|select|button)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/i, " ");
  const links = [];
  if (wantLinks) {
    // 본문(메뉴·머리말·꼬리말을 뺀 부분)의 링크를 먼저, 남는 자리에 나머지
    const bodyOnly = h.replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
    const src = bodyOnly + " " + h;
    const re = /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi; let m; const seen = new Set();
    while ((m = re.exec(src)) && links.length < 80) {
      let href; try { href = new URL(decodeEntities(m[1]), base).href; } catch (e) { continue; }
      if (!/^https?:/.test(href) || seen.has(href)) continue;
      const text = blockText(m[2]).replace(/\s+/g, " ").slice(0, 100);
      if (!text) continue;
      seen.add(href); links.push({ text, url: href });
    }
  }
  // 본문 후보: <article> → <main> → 본문 전체(머리말·꼬리말·메뉴 제거)
  const pickTag = tag => { const m = h.match(new RegExp(`<${tag}[\\s>][\\s\\S]*<\\/${tag}>`, "i")); return m ? m[0] : ""; };
  let core = "";
  for (const tag of ["article", "main"]) {
    const t = pickTag(tag); const txt = t ? blockText(t) : "";
    if (txt.length > 400) { core = txt; break; }
  }
  if (!core) {
    const body = (h.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, h])[1];
    core = blockText(body.replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " "));
    if (core.length < 200) core = blockText(body); // 메뉴를 뺐더니 거의 비면 원래대로
  }
  return { title: title.replace(/\s+/g, " ").trim().slice(0, 300), description: description.slice(0, 500), published, text: core, links };
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
const JS_WALL = /(enable javascript|javascript (is )?(required|disabled)|자바스크립트를 (사용|활성)|JavaScript를 (사용|활성)|브라우저에서 javascript)/i;

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
    if (/pdf/i.test(ct) || /\.pdf($|\?)/i.test(u.pathname) || /\.pdf$/i.test(filename)) { clearTimeout(t); return { ok: false, pdf: true, why: "PDF 파일", url: u.href }; }
    // 한글 문서(HWP·HWPX)와 이름 모를 첨부(octet-stream·attachment)는 파일로 받아 서버에서 글로 바꾼다
    const hwpLike = /hwp/i.test(ct) || /\.hwpx?($|\?)/i.test(u.pathname) || /\.hwpx?$/i.test(filename);
    const attachment = /octet-stream|x-download|force-download/i.test(ct) || /attachment/i.test(cd);
    if (hwpLike || (attachment && !/html|text\/plain|json|xml/i.test(ct))) {
      const got = await readCapped(r, MAX_FILE_BYTES);
      clearTimeout(t);
      if (!got) return { ok: false, why: "파일을 받다가 끊김", url: u.href };
      if (got.truncated) return { ok: false, why: `파일이 너무 큼(${Math.round(MAX_FILE_BYTES / 1048576)}MB 초과)`, url: u.href };
      return { ok: true, binary: true, url: u.href, contentType: ct, filename, buf: got.buf };
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
async function postJson(url, key, body, timeoutMs) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
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
    return j;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("응답 시간 초과");
    throw e;
  } finally { clearTimeout(t); }
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
  try {
    const j = await postJson("https://sdk.nimbleway.com/v2/extract", key, { url, render: true, formats: ["markdown"], country: "KR", locale: "ko-KR" }, 90000);
    const md = j && j.data && j.data.markdown;
    if (j.status !== "success" || !md) throw new Error(`실패(status=${j.status || "?"}, 사이트 응답 ${j.status_code || "?"})`);
    return { text: String(md), url: j.url || url };
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
      time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "기간 제한" },
      region: { type: "string", enum: ["global", "kr"], description: "kr이면 한국 결과를 우선(기본 global)" },
      include_domains: { type: "array", items: { type: "string" }, description: "이 도메인에서만(예: [\"sec.gov\"])" },
      exclude_domains: { type: "array", items: { type: "string" } }
    }, required: ["query"] }
  },
  {
    name: "fetch_page",
    description: "웹페이지 주소 하나의 본문을 글로 읽는다(검색 결과·기사·보도자료·공지·회사 홈페이지 등). 먼저 직접 접속하고, 자바스크립트로 그리거나 접속을 막는 페이지는 대체 경로로 다시 읽는다. robots.txt가 수집을 막은 사이트(네이버 뉴스·블로그·카페 등)는 읽지 않는다 — 네이버 뉴스는 검색 결과의 언론사 원문 주소(originallink)를 읽는다. 한글 문서(HWP·HWPX) 첨부 주소도 받으면 본문과 표를 글로 바꿔 준다(배포용·암호 문서는 제외). PDF는 대체 경로로 읽는다. 긴 본문은 start로 이어 읽는다. links=true면 페이지 안 링크 목록(최대 80개)도 준다(게시판 목록에서 글 주소를 찾을 때).",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "http·https 주소" },
      start: { type: "integer", minimum: 0, description: "이어 읽을 글자 위치(앞 결과의 next_start)" },
      max_chars: { type: "integer", minimum: 1000, maximum: MAX_CHARS, description: `한 번에 받을 글자 수(기본 ${DEFAULT_CHARS})` },
      links: { type: "boolean", description: "페이지 안 링크 목록도 받기" }
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

async function webSearch(a, caller) {
  const q = String(a.query || "").trim().slice(0, 400);
  if (!q) return textResult("query가 비어 있습니다", null, true);
  if (!(await take(dayKey("search", caller), LIMITS().search, 2 * 86400))) {
    return textResult(`오늘 웹 검색 한도(${LIMITS().search}회)를 다 썼습니다. 네이버 검색(search_naver)이나 이미 찾은 주소의 본문 읽기(fetch_page)로 이어 가세요.`, null, true);
  }
  const n = Math.min(10, Math.max(1, Math.round(Number(a.max_results) || 5)));
  const topic = a.topic === "news" ? "news" : "general";
  const tr = ["day", "week", "month", "year"].includes(a.time_range) ? a.time_range : undefined;
  const inc = Array.isArray(a.include_domains) ? a.include_domains.map(String).slice(0, 20) : undefined;
  const exc = Array.isArray(a.exclude_domains) ? a.exclude_domains.map(String).slice(0, 20) : undefined;
  const notes = [];
  let results = null, via = "";
  if (process.env.TAVILY_API_KEY) {
    try {
      const body = { query: q, search_depth: "basic", max_results: n, topic };
      if (tr) body.time_range = tr;
      if (inc && inc.length) body.include_domains = inc;
      if (exc && exc.length) body.exclude_domains = exc;
      if (a.region === "kr" && topic === "general") body.country = "south korea";
      const j = await postJson("https://api.tavily.com/search", process.env.TAVILY_API_KEY, body, 30000);
      results = (j.results || []).map(r => ({ title: r.title || "", url: r.url || "", snippet: String(r.content || "").slice(0, 700), published: r.published_date || "" }));
      via = "tavily";
    } catch (e) { notes.push(`1차 검색 실패: ${e.message}`); console.log(`[web] tavily search 실패: ${e.message}`); }
  }
  if (!results && process.env.NIMBLE_API_KEY) {
    if (!(await take(nimbleKey(), LIMITS().nimbleMonth, 40 * 86400))) notes.push("이번 달 대체 검색 한도에 도달");
    else {
      try {
        const body = { query: q, max_results: n, search_depth: "lite" };
        if (tr) body.time_range = tr;
        if (topic === "news") body.focus = "news";
        if (inc && inc.length) body.include_domains = inc;
        if (exc && exc.length) body.exclude_domains = exc;
        const j = await postJson("https://sdk.nimbleway.com/v2/search", process.env.NIMBLE_API_KEY, body, 40000);
        results = (j.results || []).map(r => ({ title: r.title || "", url: r.url || "", snippet: String(r.description || r.content || "").slice(0, 700), published: (r.metadata && r.metadata.date) || "" }));
        via = "nimble";
      } catch (e) { await giveBack(nimbleKey()); notes.push(`2차 검색 실패: ${e.message}`); console.log(`[web] nimble search 실패: ${e.message}`); }
    }
  }
  if (!results) {
    await giveBack(dayKey("search", caller));
    const why = !process.env.TAVILY_API_KEY && !process.env.NIMBLE_API_KEY ? "웹 검색 키가 서버에 설정되지 않았습니다" : notes.join(" / ");
    return textResult(`웹 검색을 하지 못했습니다: ${why}. 네이버 검색(search_naver)으로 대신 찾으세요.`, { query: q, results: [], notes }, true);
  }
  const lines = [`[웹 검색] ${q} — ${results.length}건`];
  results.forEach((r, i) => lines.push(`${i + 1}. ${r.title}${r.published ? ` (${String(r.published).slice(0, 10)})` : ""}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ")}`));
  lines.push("요약은 본문 일부다. 수치·인용은 fetch_page로 원문을 읽고 확인한 뒤 쓴다.");
  return textResult(lines.join("\n"), { query: q, engine: via, results, notes });
}

async function fetchPage(a, caller) {
  let u;
  try { u = await checkUrl(a.url); } catch (e) { return textResult(e.message, null, true); }
  if (!(await robotsAllowed(u))) {
    return textResult(`이 사이트는 robots.txt로 자동 수집을 막아 두어 읽지 않습니다: ${u.href}. 검색 결과의 요약만 쓰거나, 같은 내용을 다룬 다른 출처를 찾으세요.`, { url: u.href, blocked: "robots" }, true);
  }
  const maxChars = Math.min(MAX_CHARS, Math.max(1000, Math.round(Number(a.max_chars) || DEFAULT_CHARS)));
  const start = Math.max(0, Math.round(Number(a.start) || 0));
  const blocked = await abnormalCall("fetch", caller, `${u.href}|${start}|${maxChars}|${a.links ? 1 : 0}`);
  if (blocked) return textResult(blocked, { url: u.href, blocked: "abnormal" }, true);
  const tried = [];
  let page = null;
  const d = await directFetch(u);
  if (d.robots) return textResult(`이동한 주소가 robots.txt로 수집을 막아 두어 읽지 않습니다: ${d.url}`, { url: d.url, blocked: "robots" }, true);
  if (d.ok && d.binary) {
    let h = null, err = null;
    try { h = await hwp.hwpToText(d.buf); } catch (e) { err = e.message; }
    if (h && h.text) page = { via: h.kind, url: d.url, title: d.filename || "", text: h.text, links: [] };
    else if (err) return textResult(`한글 문서를 글로 바꾸지 못했습니다(${err}): ${d.url}. 같은 내용의 PDF·문서뷰어 주소가 있으면 그쪽을 읽으세요.`, { url: d.url, filename: d.filename, error: err }, true);
    else tried.push(`직접 접속: 글로 읽을 수 없는 파일(${(d.contentType || "").split(";")[0] || "알 수 없음"}${d.filename ? `, ${d.filename}` : ""})`);
  } else if (d.ok) {
    if (/html|xml/i.test(d.contentType) && /<html|<body|<div|<p[\s>]/i.test(d.body.slice(0, 20000))) {
      const h = htmlToText(d.body, d.url, !!a.links);
      const thin = h.text.length < 200 || (h.text.length < 1500 && JS_WALL.test(h.text));
      if (!thin) page = { via: "direct", url: d.url, title: h.title, description: h.description, published: h.published, text: h.text, links: h.links };
      else tried.push(`직접 접속: 본문이 거의 없음(${h.text.length}자, 자바스크립트로 그리는 페이지로 보임)`);
    } else {
      page = { via: "direct", url: d.url, title: "", text: d.body.trim(), links: [] };
    }
  } else tried.push(`직접 접속: ${d.why}`);

  if (!page) {
    if (!(await take(dayKey("paidfetch", caller), LIMITS().paidFetch, 2 * 86400))) {
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
    if (!page) {
      await giveBack(dayKey("paidfetch", caller));
      return textResult(`이 페이지를 읽지 못했습니다(${tried.join(" / ")}). 검색 결과 요약만 쓰거나 다른 출처를 찾으세요.`, { url: u.href, tried }, true);
    }
  }
  const s = sliceText(page.text, start, maxChars);
  const head = [`${page.via === "hwp" || page.via === "hwpx" ? "[한글 문서]" : "[웹페이지]"} ${page.title || page.url}`, `주소: ${page.url}`];
  if (page.via === "hwp" || page.via === "hwpx") head.push("표는 셀 단위 마크다운 표로, 셀 안 줄바꿈은 ' / '로 바꿨습니다(병합 칸은 왼쪽 위 칸에만 글).");
  if (page.published) head.push(`게시: ${page.published}`);
  if (page.description && start === 0) head.push(`설명: ${page.description}`);
  head.push(`글자 ${s.start}~${s.end} / 전체 ${s.total}${s.next !== null ? ` — 이어 읽으려면 start=${s.next}` : ""}`);
  let text = head.join("\n") + "\n\n" + s.part;
  if (a.links && page.links && page.links.length) text += "\n\n[링크]\n" + page.links.map(l => `- ${l.text} — ${l.url}`).join("\n");
  return textResult(text, { url: page.url, title: page.title, published: page.published || "", description: start === 0 ? (page.description || "") : "", text: s.part, via: page.via, start: s.start, end: s.end, total_chars: s.total, next_start: s.next, links: a.links ? page.links : undefined, tried: tried.length ? tried : undefined });
}

async function call(name, args, caller) {
  const a = args || {};
  if (name === "web_search") return webSearch(a, caller);
  if (name === "fetch_page") return fetchPage(a, caller);
  throw new Error(`알 수 없는 웹 도구: ${name}`);
}

module.exports = { TOOLS, NAMES, call, _test: { htmlToText, parseRobots, ruleMatch, privateIp, decodeBody, cleanMd } };
