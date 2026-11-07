// HTML → 글. 2026-11-07 정규식 변환을 실제 HTML 파서(linkedom)로 바꿨다.
//
// 왜: 정규식 변환은 ① 속성 값 안의 '>'에서 태그를 잘못 끊어 위키백과에서 속성 JSON이 본문에 섞였고
//   ② 닫히지 않은 태그·중첩에서 본문을 통째로 놓쳤으며(연준 보도자료 목록: 본문 대신 머리말만 1,394자)
//   ③ 표를 칸 단위로 다루지 못해 원본 줄바꿈이 그대로 남았다(한국은행 기준금리 표가 칸마다 줄이 갈림).
//
// 본문 고르기
//   - 기사 표시가 있는 페이지(og:type=article, JSON-LD Article류, article:published_time)는 Readability(파이어폭스
//     읽기 모드와 같은 라이브러리)로 본문만 고른다. 메뉴·많이 본 기사·추천 기사 목록이 빠진다.
//   - 그 밖의 페이지(게시판 목록·통계표·기관 안내)는 종전처럼 <article>(하나일 때)·<main>·본문 영역 →
//     머리말·꼬리말·메뉴를 뺀 본문 전체 순으로 고른다. 목록 페이지에서 목록이 빠지지 않게 하려는 것.
//   - 본문이 거의 없으면(자바스크립트로 그리는 페이지) 페이지에 들어 있는 데이터(JSON-LD articleBody,
//     Next.js __NEXT_DATA__, Arc XP Fusion.globalContent 등)에서 글을 꺼낸다.
// 표
//   - 칸 병합(colspan·rowspan)을 살려 마크다운 표로(한글 문서 변환과 같은 gridToMarkdown).
//   - 1열 표·표 안의 표·아주 긴 칸이 있는 표는 배치용 표로 보고 문단으로 푼다.

const { parseHTML } = require("linkedom");
const parse5 = require("parse5");
// linkedom은 표준 HTML 트리 구성을 하지 않아, DOCTYPE 앞 공백·조건부 주석이 있는 페이지에서 body가 비었다(2026-11-07 실측: 한국장학재단).
// 그래서 표준 파서(parse5)로 한 번 정리한 HTML을 linkedom에 넣는다.
function parseDoc(html) {
  let norm = html;
  try { norm = parse5.serialize(parse5.parse(html)); } catch (e) { /* 원본 그대로 */ }
  return parseHTML(norm).document;
}
const { Readability, isProbablyReaderable } = require("@mozilla/readability");
const { renderTable } = require("./docs");

const SKIP = new Set(["script", "style", "noscript", "svg", "template", "canvas", "select", "button", "iframe", "frame", "frameset", "object", "embed", "audio", "video", "input", "textarea", "head", "link", "meta", "map", "dialog"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "ul", "ol", "dl", "dd", "dt", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "figure", "figcaption", "main", "aside", "nav", "form", "fieldset", "address", "details", "summary", "center", "hr", "caption", "legend"]);
const CHROME_SEL = "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], #gnb, #lnb, #snb, .gnb, .lnb, .snb, #header, #footer, #skipNav, #skipnav, .skip, .skipnav, #skip-link, .breadcrumb, .location, #quick, .quick";
const JS_WALL = /(enable javascript|javascript (is )?(required|disabled)|자바스크립트를 (사용|활성|지원)|JavaScript를 (사용|활성)|브라우저에서 javascript)/i;

function isHidden(el) {
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const st = (el.getAttribute("style") || "").replace(/\s+/g, "").toLowerCase();
  return st.includes("display:none") || st.includes("visibility:hidden");
}

// ---------- DOM → 글 ----------
function nodeText(root, opts) {
  opts = opts || {};
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) { out.push(n.nodeValue.replace(/[\s ]+/g, " ")); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (SKIP.has(tag) || isHidden(n)) return;
    if (tag === "br") { out.push("\n"); return; }
    if (tag === "img") { const alt = (n.getAttribute("alt") || "").trim(); if (alt.length >= 2 && alt.length <= 80 && !opts.inCell) out.push(` [그림: ${alt}] `); return; }
    if (tag === "table") { const t = tableText(n, opts); if (t) out.push(opts.inCell ? ` ${t} ` : `\n${t}\n`); return; }
    if (tag === "pre") { out.push("\n" + n.textContent + "\n"); return; }
    if (/^h[1-6]$/.test(tag)) { out.push(opts.inCell ? " " : "\n\n## "); n.childNodes.forEach(walk); out.push("\n"); return; }
    if (tag === "li") { out.push(opts.inCell ? " · " : "\n- "); n.childNodes.forEach(walk); out.push("\n"); return; }
    const block = BLOCK.has(tag);
    if (block) out.push("\n");
    n.childNodes.forEach(walk);
    if (block) out.push("\n");
  };
  walk(root);
  return out.join("").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/^(?:[-·]\s*)+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

function tableText(table, opts) {
  const rows = [];
  // 이 표에 바로 딸린 행만(안쪽 표의 행 제외)
  const collect = (el) => {
    for (const c of el.children) {
      const t = c.tagName.toLowerCase();
      if (t === "tr") rows.push(c);
      else if (t === "thead" || t === "tbody" || t === "tfoot") collect(c);
    }
  };
  collect(table);
  if (!rows.length) return nodeText(table.ownerDocument.createElement("div"));
  const nested = !!table.querySelector("table");
  if (opts && opts.inCell) {
    // 칸 안의 표는 행마다 한 줄로
    return rows.map(r => [...r.children].filter(c => /^t[dh]$/i.test(c.tagName)).map(c => nodeText(c, { inCell: true }).replace(/\s+/g, " ").trim()).filter(Boolean).join(" ")).filter(Boolean).join(" ; ");
  }
  const cells = []; const taken = new Set();
  rows.forEach((tr, r) => {
    let col = 0;
    for (const td of tr.children) {
      if (!/^t[dh]$/i.test(td.tagName) || isHidden(td)) continue;
      while (taken.has(`${r},${col}`)) col++;
      const cs = Math.min(50, Math.max(1, parseInt(td.getAttribute("colspan"), 10) || 1));
      const rs = Math.min(500, Math.max(1, parseInt(td.getAttribute("rowspan"), 10) || 1));
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) taken.add(`${r + i},${col + j}`);
      const text = nested ? nodeText(td) : nodeText(td, { inCell: true });
      cells.push({ row: r, col, rowSpan: rs, colSpan: cs, text });
      col += cs;
    }
  });
  const capEl = table.querySelector("caption");
  const cap = capEl ? nodeText(capEl, { inCell: true }).replace(/\s+/g, " ").trim() : "";
  const nonEmpty = cells.filter(c => c.text.trim());
  if (!nonEmpty.length) return "";
  // 1행짜리 표는 한 줄로
  if (new Set(nonEmpty.map(c => c.row)).size === 1 && !nested) return (cap ? `표: ${cap}\n` : "") + nonEmpty.map(c => c.text.replace(/\s+/g, " ").trim()).join(" | ");
  const body = renderTable(cells, rows.length, 0, nested);
  return (cap && !nested ? `표: ${cap}\n` : "") + body;
}

// ---------- 메타·내장 데이터 ----------
function meta(document, sel) { const el = document.querySelector(sel); return el ? (el.getAttribute("content") || "").trim() : ""; }
function jsonLdObjects(document) {
  const out = [];
  const add = o => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(add); return; }
    out.push(o);
    if (Array.isArray(o["@graph"])) o["@graph"].forEach(add);
    if (o.mainEntity && typeof o.mainEntity === "object") add(o.mainEntity);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { add(JSON.parse(s.textContent.trim())); } catch (e) { /* 깨진 JSON-LD는 건너뜀 */ }
  }
  return out;
}
const isArticleType = t => [].concat(t || []).some(x => /Article|BlogPosting|Report|NewsArticle|PressRelease/i.test(String(x)));

// 문자열 안에서 marker 뒤 첫 '{'부터 짝이 맞는 '}'까지 잘라 JSON으로
function jsonAfter(src, marker) {
  const i = src.indexOf(marker); if (i < 0) return null;
  const s = src.indexOf("{", i + marker.length); if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = s; k < src.length && k < s + 8e6; k++) {
    const ch = src[k];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(src.slice(s, k + 1)); } catch (e) { return null; } } }
  }
  return null;
}
const SKIP_KEYS = /^(url|src|href|link|id|_id|uuid|canonical.*|image.*|thumbnail.*|photo.*|video.*|css|class(name)?|style|script|token|hash|key|slug|path|type|subtype|mime.*|width|height|alt|caption_?credit|credits?|tags?|keywords?|seo.*|meta.*|og.*|twitter.*|tracking.*|ads?|advert.*|related.*|recommend.*|popular.*|ranking.*|footer.*|header.*|nav.*|menu.*)$/i;
function stripTags(s) { return String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ").trim(); }
// 데이터 묶음에서 문장처럼 보이는 글만 순서대로 모은다
function proseFrom(obj) {
  // Arc XP: content_elements [{type:"text", content}]
  const arc = [];
  const findArc = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 12 || arc.length) return;
    if (Array.isArray(o.content_elements) && o.content_elements.some(e => e && e.type === "text")) {
      o.content_elements.forEach(e => { if (e && (e.type === "text" || e.type === "header") && e.content) arc.push((e.type === "header" ? "## " : "") + stripTags(e.content)); });
      return;
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) findArc(v, depth + 1);
  };
  findArc(obj, 0);
  if (arc.join("").length >= 200) return arc;
  const out = []; const seen = new Set();
  const walk = (o, key, depth) => {
    if (depth > 30 || out.length > 400) return;
    if (typeof o === "string") {
      if (key && SKIP_KEYS.test(key)) return;
      if (o.length < 40 || /^(https?:|\/\/|data:|\{|\[)/.test(o)) return;
      const t = stripTags(o);
      if (t.length < 40 || (t.match(/\s/g) || []).length < 4) return;
      if (/[{};]\s*[a-z-]+\s*:/.test(t) && !/[가-힣]/.test(t)) return; // CSS·코드
      if (seen.has(t)) return; seen.add(t); out.push(t); return;
    }
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) o.forEach(v => walk(v, key, depth + 1));
    else for (const [k, v] of Object.entries(o)) { if (SKIP_KEYS.test(k)) continue; walk(v, k, depth + 1); }
  };
  walk(obj, "", 0);
  return out;
}
function embeddedText(document, ld) {
  // 1) JSON-LD articleBody
  for (const o of ld) if (typeof o.articleBody === "string" && o.articleBody.trim().length >= 200) return { text: stripTags(o.articleBody), from: "JSON-LD articleBody" };
  // 2) 페이지 상태 데이터
  const tries = [];
  const nd = document.querySelector("script#__NEXT_DATA__");
  if (nd) { try { tries.push(["Next.js 데이터", JSON.parse(nd.textContent)]); } catch (e) {} }
  const nuxt = document.querySelector("script#__NUXT_DATA__");
  if (nuxt) { try { tries.push(["Nuxt 데이터", JSON.parse(nuxt.textContent)]); } catch (e) {} }
  for (const s of document.querySelectorAll("script:not([src])")) {
    const src = s.textContent;
    if (src.length < 200) continue;
    for (const mk of ["Fusion.globalContent", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__", "__NEXT_DATA__"]) {
      if (src.includes(mk)) { const j = jsonAfter(src, mk); if (j) tries.push([mk === "Fusion.globalContent" ? "Arc 데이터" : mk.replace(/_/g, "") + " 데이터", j]); }
    }
  }
  for (const [label, obj] of tries) {
    const parts = proseFrom(obj);
    const text = parts.join("\n\n");
    if (text.length >= 300) return { text, from: label };
  }
  return null;
}

// ---------- 링크 ----------
function linkList(document, base) {
  const links = []; const seen = new Set();
  const add = (a) => {
    if (links.length >= 80) return;
    const raw = a.getAttribute("href") || ""; if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return;
    let href; try { href = new URL(raw, base).href; } catch (e) { return; }
    if (!/^https?:/.test(href) || seen.has(href)) return;
    let text = nodeText(a, { inCell: true }).replace(/\s+/g, " ").trim();
    if (!text) { const img = a.querySelector("img[alt]"); text = img ? img.getAttribute("alt").trim() : ""; }
    if (!text) text = (a.getAttribute("title") || "").trim();
    if (!text) return;
    seen.add(href); links.push({ text: text.slice(0, 100), url: href });
  };
  const body = document.body; if (!body) return links;
  const all = [...body.querySelectorAll("a[href]")];
  // 본문(메뉴·머리말·꼬리말 밖)의 링크를 먼저, 남는 자리에 나머지
  const chrome = new Set(body.querySelectorAll(CHROME_SEL));
  const inChrome = el => { for (let p = el; p; p = p.parentElement) if (chrome.has(p)) return true; return false; };
  all.filter(a => !inChrome(a)).forEach(add);
  all.forEach(add);
  return links;
}

// ---------- iframe ----------
function siteKey(host) { const p = host.toLowerCase().split("."); const two = /^(co|go|or|ac|ne|re|pe|ms|hs|es|sc|kg|mil|com|net|org|gov|edu)$/; return p.length >= 3 && two.test(p[p.length - 2]) ? p.slice(-3).join(".") : p.slice(-2).join("."); }
function frameList(document, base) {
  const out = [];
  let baseHost = ""; try { baseHost = new URL(base).hostname; } catch (e) {}
  for (const f of document.querySelectorAll("iframe[src], frame[src]")) {
    let u; try { u = new URL(f.getAttribute("src"), base); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol) || siteKey(u.hostname) !== siteKey(baseHost)) continue;
    if (/ads|banner|analytics|tracking|googletag|player|video|map/i.test(u.href)) continue;
    const label = `${f.getAttribute("id") || ""} ${f.getAttribute("name") || ""} ${f.getAttribute("title") || ""}`.trim();
    out.push({ url: u.href, label, content: /content|main|body|본문|view|frm|service|board|bbs|doc/i.test(label + " " + u.pathname) });
  }
  return out.slice(0, 5);
}

// ---------- 본문 고르기 ----------
function pickCore(document) {
  const body = document.body;
  if (!body) return "";
  const len = el => nodeText(el).length;
  const mains = [...document.querySelectorAll("main, [role=main]")];
  const arts = [...document.querySelectorAll("article")].filter(a => !a.parentElement || !a.parentElement.closest("article"));
  if (arts.length === 1 && len(arts[0]) > 400) return nodeText(arts[0]);
  for (const m of mains) if (len(m) > 400) return nodeText(m);
  // 머리말·꼬리말·메뉴를 뺀 본문
  const clone = body.cloneNode(true);
  clone.querySelectorAll(CHROME_SEL).forEach(e => e.remove());
  const rest = nodeText(clone);
  for (const sel of ["#mw-content-text", "#contents", "#content", "#container_content", ".contents", ".content", "#body_content"]) {
    const el = clone.querySelector(sel);
    if (el) { const t = nodeText(el); if (t.length > 400 && t.length >= rest.length * 0.3) return t; }
  }
  if (rest.length >= 200) return rest;
  return nodeText(body);
}

// 본문 쪽(메뉴·사이드바 밖) 자료 표: 안에 표가 없고 5행 이상
const SIDE_RE = /\b(sidebar|side|aside|rank|ranking|popular|most|related|widget|banner|navbox|infobox|menu|gnb|lnb|snb)\b/i;
function dataTables(root) {
  if (!root) return [];
  const chrome = new Set(root.querySelectorAll(CHROME_SEL));
  return [...root.querySelectorAll("table")].filter(t => {
    if (t.querySelector("table") || t.querySelectorAll("tr").length < 5) return false;
    if (/\b(navbox|infobox)\b/i.test(t.getAttribute("class") || "")) return false;
    for (let p = t.parentElement; p && p !== root; p = p.parentElement) {
      if (chrome.has(p)) return false;
      if (SIDE_RE.test(`${p.getAttribute("class") || ""} ${p.getAttribute("id") || ""}`)) return false;
    }
    return true;
  });
}

// html → { title, description, published, text, links, mode, frames, thin, notes }
function htmlToPage(html, base, wantLinks) {
  const document = parseDoc(html);
  const title = meta(document, 'meta[property="og:title"]') || ((document.querySelector("title") || {}).textContent || "").trim();
  const description = meta(document, 'meta[name="description"]') || meta(document, 'meta[property="og:description"]');
  const ld = jsonLdObjects(document);
  const ldArt = ld.find(o => isArticleType(o["@type"]));
  const published = meta(document, 'meta[property="article:published_time"]') || meta(document, 'meta[name="article:published_time"]') || meta(document, 'meta[property="og:article:published_time"]') || meta(document, 'meta[name="pubdate"]') || meta(document, 'meta[name="publishdate"]') || meta(document, 'meta[name="date"]') || (ldArt && typeof ldArt.datePublished === "string" ? ldArt.datePublished : "");
  const ogType = meta(document, 'meta[property="og:type"]').toLowerCase();
  const articleLike = ogType.includes("article") || !!ldArt || !!meta(document, 'meta[property="article:published_time"]');
  const frames = frameList(document, base);
  const links = wantLinks ? linkList(document, base) : [];
  const notes = [];
  let text = "", mode = "page";

  if (articleLike) {
    try {
      const d2 = parseDoc(html);
      if (isProbablyReaderable(d2, { minContentLength: 100, minScore: 10 })) {
        const r = new Readability(d2, { charThreshold: 300, keepClasses: false }).parse();
        if (r && r.content) {
          const { document: d3 } = parseHTML(`<html><body>${r.content}</body></html>`);
          const t = nodeText(d3.body);
          // Readability는 링크가 많은 자료 표(국가 목록 등)를 본문이 아니라고 지운다(2026-11-07 실측: 위키백과 GDP 표 223행 누락).
          // 본문 쪽 자료 표가 기사 본문에서 빠졌으면 기사 본문 고르기를 쓰지 않는다.
          const lost = dataTables(document.body).length > dataTables(d3.body).length;
          if (lost) notes.push("자료 표가 많은 페이지라 기사 본문 고르기 대신 페이지 본문 전체를 읽음");
          else if (t.length >= 300) { text = t; mode = "article"; }
        }
      }
    } catch (e) { notes.push(`기사 본문 고르기 실패(${e.message.slice(0, 60)}) — 페이지 전체에서 고름`); }
    // 기사 본문이 JSON-LD articleBody보다 훨씬 짧으면 articleBody를 쓴다
    const ab = ldArt && typeof ldArt.articleBody === "string" ? stripTags(ldArt.articleBody) : "";
    if (ab.length >= 300 && ab.length > text.length * 1.5) { text = ab; mode = "article"; notes.push("기사 본문은 페이지의 기사 데이터(JSON-LD articleBody)에서 가져옴"); }
  }
  if (!text) text = pickCore(document);

  // 본문이 거의 없음: ① 200자 미만 ② 1,500자 미만인데 "자바스크립트 필요" 문구(noscript 포함)
  // ③ 800자 미만인데 줄 대부분이 짧은 메뉴 항목(25자 미만) — 화면 틀만 오고 본문은 자바스크립트로 그리는 페이지
  const noscriptWall = [...document.querySelectorAll("noscript")].some(n => JS_WALL.test(n.textContent || ""));
  const lines = text.split("\n").map(l => l.replace(/^(?:[-#·]+\s*)+/, "").trim()).filter(Boolean);
  const shortRatio = lines.length ? lines.filter(l => l.length < 25).length / lines.length : 1;
  let thin = text.length < 200 || (text.length < 1500 && JS_WALL.test(text)) || (mode !== "article" && text.length < 500 && noscriptWall) || (mode !== "article" && text.length < 800 && shortRatio >= 0.8);
  if (thin) {
    const emb = embeddedText(document, ld);
    if (emb && emb.text.length > text.length) {
      text = emb.text; mode = "data"; thin = false;
      notes.push(`화면에 그려지기 전의 페이지 데이터(${emb.from})에서 글을 꺼냄 — 표·배치는 없을 수 있고 관련 기사 문구가 섞일 수 있음`);
    }
  }
  return { title: title.replace(/\s+/g, " ").slice(0, 300), description: description.slice(0, 500), published, text, links, mode, frames, thin, notes };
}

module.exports = { htmlToPage, JS_WALL, _test: { nodeText, tableText, embeddedText, proseFrom, jsonAfter, pickCore, siteKey, frameList } };
