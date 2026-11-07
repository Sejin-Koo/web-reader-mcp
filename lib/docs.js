// 첨부 파일(PDF·워드·엑셀·파워포인트·한글)을 글로 바꾼다 — 서버에서 직접(무료), 대체 경로(유료) 없이.
//
// 왜(2026-11-07): 공공기관 첨부는 PDF·HWP·XLSX·DOCX가 대부분인데, 종전에는 HWP·HWPX만 서버가 읽고
//   PDF는 유료 경로(Tavily)로만 읽었으며 DOCX·XLSX·PPTX는 "글로 읽을 수 없는 파일"로 끝났다.
//   그래서 direct_only(무료 직접 접속만)로 공식 원문 PDF를 읽으면 늘 실패했다.
//
// PDF  : unpdf(pdf.js 서버용 빌드)로 글자 조각과 좌표를 받아 줄을 다시 세운다. 같은 높이의 조각은 한 줄로,
//        넓은 간격은 ' | '로 표시한다(PDF에는 표 구조가 없어 칸은 간격으로 추정). 여러 쪽에 되풀이되는
//        머리말·꼬리말(쪽 번호·보안 문구)은 뺀다. 글자가 없으면(스캔 이미지) 사유를 돌려준다.
// DOCX : word/document.xml의 문단·표(w:gridSpan·w:vMerge 병합)를 순서대로.
// XLSX : 시트마다 마크다운 표(공유 문자열·병합 칸·날짜 서식). 빈 행은 XML에 없으므로 행 번호(r)를 지킨다.
//        자기닫힘 셀(<c r="C3" s="16"/>)을 먼저 처리한다 — 한 정규식으로 처리하면 빈 셀이 다음 셀 값을 삼킨다.
// PPTX : 슬라이드 순서대로 글상자 문단과 표.
// HWP·HWPX : lib/hwp.js.

const JSZip = require("jszip");
const hwp = require("./hwp");
const pdftable = require("./pdftable");
const gridToMarkdown = hwp._test.gridToMarkdown;

const MAX_PDF_PAGES = 300;
// 일본어·중국어 등 CID 글꼴의 글자 대응표(CMap). 없으면 일부 글자가 빠진다(2026-11-07 실측: 도요타 결산단신 일본어판 약 2.5% 누락).
// pdfjs-dist 5.7.284의 cmaps 폴더를 그대로 복사해 두었다(assets/cmaps, vercel.json includeFiles로 함수에 포함).
const PDF_OPTS = { cMapUrl: require("path").join(__dirname, "..", "assets", "cmaps") + "/", cMapPacked: true };
const MAX_SHEET_ROWS = 2000, MAX_SHEET_COLS = 60; // gridToMarkdown은 2,000행을 넘으면 표를 풀어 버린다

// 표 하나를 글로. 칸이 사실상 1열이거나, 안에 표가 또 있거나, 칸 하나가 아주 길면 배치용 표(양식 틀)로 보고
// 칸 글을 순서대로 문단으로 낸다(안쪽 표는 이미 마크다운 표로 들어 있음). 그 밖에는 마크다운 표.
function renderTable(cells, nRows, nCols, nested) {
  cells = cells.filter(c => String(c.text || "").trim());
  if (!cells.length) return "";
  const cols = new Set(cells.map(c => c.col));
  const longest = Math.max(...cells.map(c => String(c.text).length));
  if (cols.size <= 1 || nested || longest > 600) {
    return cells.slice().sort((a, b) => a.row - b.row || a.col - b.col).map(c => String(c.text).trim()).join("\n");
  }
  return gridToMarkdown(cells, nRows, nCols);
}

function isPdf(buf) { return buf.length > 5 && buf.subarray(0, 1024).toString("latin1").includes("%PDF-"); }
function isZip(buf) { return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04; }
function isOle(buf) { return buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0; }

function xmlUnescape(s) {
  return String(s).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function attr(tag, name) { const m = String(tag).match(new RegExp(`(?:^|\\s)${name.replace(/:/g, "\\:")}="([^"]*)"`)); return m ? m[1] : null; }
const tidy = s => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// ---------------- PDF ----------------
// 같은 높이(글자 크기의 절반 이내)의 글자 조각을 한 줄로. 넓은 간격은 ' | '
function pdfLines(items) {
  items = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const L = lines.length ? lines[lines.length - 1] : null;
    if (L && Math.abs(L.y - it.y) <= Math.max(2, Math.min(L.fs, it.fs) * 0.5)) L.items.push(it);
    else lines.push({ y: it.y, fs: it.fs, items: [it] });
  }
  const out = [];
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    let s = "", end = null, gaps = 0;
    for (const it of L.items) {
      const blank = !it.s.trim();
      if (end !== null) {
        const gap = it.x - end;
        if (gap > it.fs * 2.2 && !blank) { s = s.replace(/\s+$/, "") + " | "; gaps++; }
        else if (gap > it.fs * 0.15 && !/\s$/.test(s) && !blank) s += " ";
      }
      s += blank ? (/\s$/.test(s) ? "" : " ") : it.s;
      end = Math.max(end === null ? -Infinity : end, it.x + it.w);
    }
    s = s.replace(/[ \t\u00a0]+/g, " ").trim();
    if (s) out.push({ y: L.y, text: s, gaps });
  }
  return out;
}

// PDF 표 → 글. 한 행 전체를 차지하는 칸 하나만 있는 행(테두리 상자 안의 본문 글)은 표 밖 문단으로 내고,
// 나머지 행만 표로 만든다(2026-11-07 실측: 현대차 인도 보도자료 — 쪽 전체 테두리 안에 본문과 실적표가 함께 있음).
function renderPdfTable(cells, R, C) {
  const byRow = new Map(); cells.forEach(c => { if (!byRow.has(c.row)) byRow.set(c.row, []); byRow.get(c.row).push(c); });
  const full = r => { const cs = (byRow.get(r) || []).filter(c => String(c.text || "").trim()); return cs.length === 1 && cs[0].colSpan >= C && cs[0].rowSpan === 1; };
  const out = []; let seg = null;
  const flush = () => {
    if (!seg) return;
    const a = seg.a, b = seg.b;
    const part = cells.filter(c => c.row >= a && c.row <= b).map(c => Object.assign({}, c, { row: c.row - a, rowSpan: Math.min(c.rowSpan, b - c.row + 1) }));
    const t = renderTable(part, b - a + 1, C, false); if (t) out.push(t); seg = null;
  };
  for (let r = 0; r < R; r++) {
    if (full(r)) { flush(); out.push(byRow.get(r).find(c => String(c.text || "").trim()).text); }
    else if (byRow.has(r) || seg) { if (!seg) seg = { a: r, b: r }; else seg.b = r; }
  }
  flush();
  return out.join("\n");
}

async function pdfToText(buf) {
  const { getDocumentProxy } = await import("unpdf");
  let OPS = null;
  try { OPS = (await import("unpdf/pdfjs")).OPS; } catch (e) { OPS = null; }
  let doc;
  try { doc = await getDocumentProxy(new Uint8Array(buf), PDF_OPTS); }
  catch (e) { throw new Error(/password/i.test(e.message || "") ? "암호가 걸린 PDF라 읽을 수 없음" : `PDF를 열지 못함(${(e.message || "").slice(0, 80)})`); }
  const nPages = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pages = [];
  const check = { ok: 0, failed: [], borderless: [] };
  for (let p = 1; p <= nPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it || typeof it.str !== "string" || !it.str.length) continue;
      const fs = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10;
      items.push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, fs });
    }
    // 각주 위첨자: 숫자 바로 뒤에 작고 위로 올라간 숫자 조각("– 2,480" + "1")은 이어 붙으면 "2,4801"로 읽힌다(BMW 손익계산서 실측).
    // 앞 글자보다 글자 크기가 0.75배 이하이고 기준선이 위로 올라갔으며 바로 붙어 있으면 위첨자 문자로 바꾼다.
    const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", ",": "˒", "*": "*" };
    for (const it of items) {
      const t = it.s.trim();
      if (!/^[\d,*]{1,5}$/.test(t)) continue;
      const host = items.find(o => o !== it && o.s.trim() && o.fs >= it.fs * 1.33 && it.y > o.y + o.fs * 0.15 && it.y < o.y + o.fs * 0.9 && Math.abs(it.x - (o.x + o.w)) <= Math.max(1.5, o.fs * 0.25));
      if (host) it.s = [...t].map(ch => SUP[ch] || ch).join("");
    }
    // 표 칸 복원(테두리선) — 실패해도 글 읽기는 계속한다
    const blocks = [];
    let flow = items;
    if (OPS) {
      try {
        const vp = page.getViewport({ scale: 1 });
        const solid = items.map((it, i) => ({ it, i })).filter(o => o.it.s.trim());
        const r = pdftable.pageTables(await page.getOperatorList(), OPS, solid.map(o => o.it), vp.width, vp.height);
        const taken = new Set();
        let tno = 0;
        for (const t of r.tables) {
          if (t.box) continue; // 1행·1열짜리 글상자는 표로 보지 않는다
          tno++;
          const mine = solid.filter(o => { const it = o.it; const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3; return cx >= t.bbox.x1 - 1 && cx <= t.bbox.x2 + 1 && cy >= t.bbox.y1 - 1 && cy <= t.bbox.y2 + 1; });
          mine.forEach(o => taken.add(o.i));
          // 표 안의 공백 조각도 흐름에서 뺀다
          items.forEach((it, i) => { if (!it.s.trim()) { const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3; if (cx >= t.bbox.x1 && cx <= t.bbox.x2 && cy >= t.bbox.y1 && cy <= t.bbox.y2) taken.add(i); } });
          if (t.ok) { check.ok++; blocks.push({ y: t.bbox.y2 + 0.01, kind: "table", text: renderPdfTable(t.cells, t.R, t.C) }); }
          else {
            check.failed.push({ page: p, why: t.why });
            blocks.push({ y: t.bbox.y2 + 0.01, kind: "table", text: `[표 확인 필요 — 쪽 ${p}의 이 표는 칸을 복원하지 못했다(${t.why}). 아래 글은 칸이 섞였을 수 있으니 이 표의 수치·항목은 이 결과로 답하지 말 것]\n` + pdfLines(mine.map(o => o.it)).map(l => l.text).join("\n") + "\n[표 끝]" });
          }
        }
        flow = items.filter((_, i) => !taken.has(i));
      } catch (e) { /* 표 복원 실패 — 종전 방식으로 */ }
    }
    // 테두리 없는 표 — 칸 사이가 넓게 벌어졌거나 숫자가 여럿 늘어선 짧은 줄(표 줄)이 3줄 이상 모인 구역.
    // 표 줄 사이에 제목·단위 같은 일반 줄이 2줄까지 끼어도 한 구역으로 본다. 칸을 글자 간격으로 추정한 것이라 표시한다.
    const lines = pdfLines(flow);
    const numTok = t => (t.match(/[-–(]?\d[\d,.]*%?\)?/g) || []).filter(x => /\d{2,}|\d[,.]\d/.test(x)).length;
    // 날짜("2026. 11. 7.(토)", "’26. 11. 20.")는 값이 아니라 표 판정에서 뺀다 — 보도자료 본문 글머리가 표로 오인됐다(2026-11-07 실측)
    const undate = t => t.replace(/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?(\([^)]*\))?/g, " ").replace(/[’'‘]?\d{2}\.\s*\d{1,2}\.\s*\d{1,2}\.?(\([^)]*\))?/g, " ");
    const isTab = l => {
      const t = undate(l.text);
      const n = numTok(t); const digits = (t.match(/\d/g) || []).length;
      const words = t.split(/\s+/).filter(Boolean);
      const numericWords = words.filter(w => /^[-–(＋+−△▲▽]?[\d,.]+%?\)?$|^[－—–\-]$/.test(w) && /\d|^[－—–\-]$/.test(w)).length; // 홀로 선 숫자·빈 값 표시(－)
      return (l.gaps >= 1 && numericWords >= 1 && n >= 1) || (numericWords >= 2 && t.length <= 70 && digits / Math.max(1, t.length) >= 0.2) || l.gaps >= 2 || (n >= 3 && words.length && numericWords / words.length >= 0.4);
    };
    const tab = lines.map(isTab);
    const entries = [];
    for (let i = 0; i < lines.length;) {
      if (!tab[i]) { entries.push({ y: lines[i].y, kind: "line", text: lines[i].text }); i++; continue; }
      // 표 줄 사이에 낀 일반 줄은 3줄까지 허용(각주 번호처럼 4자 이하 짧은 줄은 세지 않음)
      let j = i, last = i, count = 0, gapLines = 0;
      while (j < lines.length) {
        if (tab[j]) { last = j; count++; gapLines = 0; }
        else if (lines[j].text.length > 4 && ++gapLines > 3) break;
        j++;
      }
      const end = last + 1;
      if (count >= 3) {
        check.borderless.push({ page: p });
        entries.push({ y: lines[i].y, kind: "table", text: `[표 확인 필요 — 쪽 ${p}: 테두리 없는 표로 보여 칸을 글자 간격으로 추정했다(' | '). 여러 줄 칸·빈 칸이 있으면 값이 옆 칸으로 밀릴 수 있으니 이 표의 수치는 원본 표로 확인한 뒤 쓸 것]\n` + lines.slice(i, end).map(l => l.text).join("\n") + "\n[표 끝]" });
        i = end;
      } else { entries.push({ y: lines[i].y, kind: "line", text: lines[i].text }); i++; }
    }
    pages.push(entries.concat(blocks).sort((a, b) => b.y - a.y));
  }
  // 여러 쪽에 되풀이되는 줄(머리말·꼬리말·쪽 번호)은 뺀다 — 숫자를 지운 모양이 쪽의 절반 이상에 나오면
  const norm = s => s.replace(/\d+/g, "#").replace(/\s+/g, "");
  const drop = new Set();
  if (pages.length >= 3) {
    const cnt = new Map();
    pages.forEach(es => new Set(es.filter(e => e.kind === "line").map(e => norm(e.text))).forEach(k => cnt.set(k, (cnt.get(k) || 0) + 1)));
    cnt.forEach((n, k) => { if (n >= Math.max(3, Math.ceil(pages.length / 2)) && k.length <= 120) drop.add(k); });
  }
  const pageNo = /^[-–—\s]*\d{1,4}[-–—\s]*$|^\d{1,4}\s*\/\s*\d{1,4}$/;
  const parts = pages.map((es, i) => {
    const kept = es.filter(e => e.kind !== "line" || (!drop.has(norm(e.text)) && !pageNo.test(e.text))).map(e => e.text);
    return kept.length ? `[쪽 ${i + 1}]\n` + kept.join("\n") : "";
  }).filter(Boolean);
  const text = tidy(parts.join("\n\n"));
  const letters = text.replace(/\[쪽 \d+\]/g, "").replace(/[\s|]/g, "").length;
  if (letters < 20 * Math.max(1, Math.min(nPages, 5)) && letters < 200) throw new Error("글자가 없는 PDF(스캔 이미지로 보임)");
  const notes = [];
  if (doc.numPages > nPages) notes.push(`전체 ${doc.numPages}쪽 중 앞 ${nPages}쪽만 읽음`);
  if (drop.size) notes.push(`여러 쪽에 되풀이되는 머리말·꼬리말 ${drop.size}줄은 뺌`);
  if (check.ok) notes.push(`표 ${check.ok}개는 테두리선으로 칸을 복원해 마크다운 표로 냄`);
  return { kind: "pdf", text, notes, tableCheck: check };
}

// ---------------- XML 공통(오피스) ----------------
// 열 문자 → 번호(A=0)
function colIndex(ref) { const m = String(ref || "").match(/^([A-Z]+)/i); if (!m) return -1; let n = 0; for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function cellRef(ref) { const m = String(ref || "").match(/^([A-Z]+)(\d+)$/i); return m ? { c: colIndex(m[1]), r: Number(m[2]) - 1 } : null; }

// ---------------- DOCX ----------------
function docxBody(xml) {
  const tok = /<(\/?)([\w]+:[\w]+|[\w]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  const stack = [{ kind: "root", text: "" }];
  const buf = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === "cell" || stack[i].kind === "root") return stack[i]; return stack[0]; };
  const tblTop = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === "tbl") return stack[i]; return null; };
  let inT = 0, m;
  while ((m = tok.exec(xml))) {
    if (m[5] !== undefined) { if (inT) buf().text += xmlUnescape(m[5]); continue; }
    const close = m[1] === "/", name = m[2], attrs = m[3] || "", self = m[4] === "/";
    if (name === "w:t") { if (!self) inT += close ? -1 : 1; continue; }
    if ((name === "w:tab") && !close) { buf().text += " "; continue; }
    if ((name === "w:br" || name === "w:cr") && !close) { buf().text += "\n"; continue; }
    if (name === "w:p" && close) { const b = buf(); if (!b.text.endsWith("\n")) b.text += "\n"; continue; }
    if (name === "w:tbl") {
      if (!close) { const outer = tblTop(); if (outer) outer.nested = true; stack.push({ kind: "tbl", rows: [], row: null, nested: false }); }
      else {
        const t = stack.pop();
        if (t && t.kind === "tbl") {
          const cells = []; const vm = {};
          t.rows.forEach((cs, r) => {
            let col = 0;
            cs.forEach(c => {
              if (c.vmerge === "continue" && vm[col]) { vm[col].rowSpan = r - vm[col].row + 1; col += c.span; return; }
              const cell = { row: r, col, rowSpan: 1, colSpan: c.span, text: c.text.trim() };
              cells.push(cell);
              if (c.vmerge === "restart") vm[col] = cell; else delete vm[col];
              col += c.span;
            });
          });
          const md = renderTable(cells, t.rows.length, 0, t.nested);
          const b = buf(); b.text += (b.text && !b.text.endsWith("\n") ? "\n" : "") + md + "\n";
        }
      }
      continue;
    }
    if (name === "w:tr") { const t = tblTop(); if (t && !close) t.rows.push([]); continue; }
    if (name === "w:tc") {
      if (!close) stack.push({ kind: "cell", text: "", span: 1, vmerge: null });
      else { const c = stack.pop(); const t = tblTop(); if (c && c.kind === "cell" && t && t.rows.length) t.rows[t.rows.length - 1].push(c); }
      continue;
    }
    if (name === "w:gridSpan" && stack[stack.length - 1].kind === "cell") { stack[stack.length - 1].span = Math.max(1, Number(attr(attrs, "w:val")) || 1); continue; }
    if (name === "w:vMerge" && stack[stack.length - 1].kind === "cell") { stack[stack.length - 1].vmerge = attr(attrs, "w:val") === "restart" ? "restart" : "continue"; continue; }
  }
  return tidy(stack[0].text);
}
async function docxToText(zip) {
  const f = zip.file("word/document.xml");
  if (!f) throw new Error("워드 문서 본문을 찾지 못함");
  const text = docxBody(await f.async("string"));
  return { kind: "docx", text, notes: [] };
}

// ---------------- XLSX ----------------
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function serialToDate(v, withTime) {
  const n = Number(v); if (!Number.isFinite(n)) return String(v);
  const ms = Math.round((n - 25569) * 86400000); const d = new Date(ms);
  if (isNaN(d)) return String(v);
  const iso = d.toISOString();
  return withTime && (n % 1) ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}
async function xlsxToText(zip) {
  const wb = await zip.file("xl/workbook.xml").async("string");
  const relsF = zip.file("xl/_rels/workbook.xml.rels");
  const rels = relsF ? await relsF.async("string") : "";
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) { const id = attr(m[1], "Id"), t = attr(m[1], "Target"); if (id && t) relMap[id] = t.replace(/^\/?xl\//, "").replace(/^\//, ""); }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = xmlUnescape(attr(m[1], "name") || ""), rid = attr(m[1], "r:id"), state = attr(m[1], "state");
    if (state === "hidden" || state === "veryHidden") continue;
    if (rid && relMap[rid]) sheets.push({ name, path: "xl/" + relMap[rid] });
  }
  // 공유 문자열
  const ss = [];
  const ssF = zip.file("xl/sharedStrings.xml");
  if (ssF) {
    const x = await ssF.async("string");
    for (const m of x.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ""); // 후리가나 제외
      ss.push([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => xmlUnescape(t[1])).join(""));
    }
  }
  // 날짜 서식
  const dateXf = [];
  const stF = zip.file("xl/styles.xml");
  if (stF) {
    const st = await stF.async("string");
    const custom = {};
    for (const m of st.matchAll(/<numFmt\b([^>]*)\/?>/g)) custom[Number(attr(m[1], "numFmtId"))] = xmlUnescape(attr(m[1], "formatCode") || "");
    const xfs = (st.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || "";
    for (const m of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
      const id = Number(attr(m[1], "numFmtId")) || 0;
      const code = custom[id] || "";
      const isDate = DATE_FMT_IDS.has(id) || (!!code && /[yd]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, "")) && !/^[#0,.%\s]+$/.test(code));
      dateXf.push(isDate ? (/[hs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, "")) || [22, 45, 46, 47].includes(id) ? "datetime" : "date") : "");
    }
  }
  const parts = [], notes = [];
  for (const sh of sheets) {
    const f = zip.file(sh.path); if (!f) continue;
    const x = await f.async("string");
    const cells = []; let maxR = -1, maxC = -1, cut = false;
    const data = (x.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/) || [])[1] || "";
    // 자기닫힘 셀을 먼저(값 없음) — 그다음 열고 닫는 셀
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    for (const m of data.matchAll(cellRe)) {
      if (m[1] !== undefined) continue;
      const a = m[2], inner = m[3];
      const ref = cellRef(attr(a, "r")); if (!ref) continue;
      if (ref.r >= MAX_SHEET_ROWS || ref.c >= MAX_SHEET_COLS) { cut = true; continue; }
      const t = attr(a, "t"), s = Number(attr(a, "s")) || 0;
      let v = (inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
      let text = "";
      if (t === "s") text = ss[Number(v)] ?? "";
      else if (t === "inlineStr") text = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(q => xmlUnescape(q[1])).join("");
      else if (t === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else if (v !== undefined) {
        v = xmlUnescape(v);
        if ((t === "n" || !t) && dateXf[s]) text = serialToDate(v, dateXf[s] === "datetime");
        else if ((t === "n" || !t) && /^-?\d+\.\d{6,}$/.test(v)) text = String(Math.round(Number(v) * 1e6) / 1e6);
        else text = v;
      }
      if (text === "" || text == null) continue;
      cells.push({ row: ref.r, col: ref.c, rowSpan: 1, colSpan: 1, text: String(text) });
      maxR = Math.max(maxR, ref.r); maxC = Math.max(maxC, ref.c);
    }
    // 병합 칸
    for (const m of x.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/gi)) {
      const a = cellRef(m[1]), b = cellRef(m[2]); if (!a || !b) continue;
      const c = cells.find(q => q.row === a.r && q.col === a.c);
      if (c) { c.rowSpan = b.r - a.r + 1; c.colSpan = b.c - a.c + 1; }
    }
    if (!cells.length) continue;
    // 위쪽·왼쪽의 빈 행·열은 잘라 낸다
    const r0 = Math.min(...cells.map(c => c.row)), c0 = Math.min(...cells.map(c => c.col));
    cells.forEach(c => { c.row -= r0; c.col -= c0; });
    const md = renderTable(cells, maxR - r0 + 1, maxC - c0 + 1, false);
    parts.push(`## 시트: ${sh.name}\n\n${md}`);
    if (cut) notes.push(`시트 '${sh.name}'는 앞 ${MAX_SHEET_ROWS}행·${MAX_SHEET_COLS}열까지만 읽음`);
  }
  if (!parts.length) throw new Error("엑셀 문서에 값이 있는 시트가 없음");
  return { kind: "xlsx", text: parts.join("\n\n"), notes };
}

// ---------------- PPTX ----------------
function pptxSlide(xml) {
  const out = [];
  const tbls = [];
  // 표를 먼저 떼어 내 자리표시로 바꾼다
  xml = xml.replace(/<a:tbl>([\s\S]*?)<\/a:tbl>/g, (all, body) => {
    const cells = []; let r = 0;
    for (const tr of body.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
      let c = 0;
      for (const tc of tr[1].matchAll(/<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>|<a:tc\b([^>]*)\/>/g)) {
        const a = tc[1] || tc[3] || "";
        if (attr(a, "hMerge") === "1" || attr(a, "vMerge") === "1") { c++; continue; }
        const text = [...(tc[2] || "").matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map(p => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(t => xmlUnescape(t[1])).join("")).filter(Boolean).join("\n");
        cells.push({ row: r, col: c, rowSpan: Number(attr(a, "rowSpan")) || 1, colSpan: Number(attr(a, "gridSpan")) || 1, text });
        c++;
      }
      r++;
    }
    tbls.push(renderTable(cells, r, 0, false));
    return `<a:p><a:t>\u0000T${tbls.length - 1}\u0000</a:t></a:p>`;
  });
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const s = [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)].map(t => t[1] !== undefined ? xmlUnescape(t[1]) : "\n").join("");
    const tm = s.match(/^\u0000T(\d+)\u0000$/);
    if (tm) out.push(tbls[Number(tm[1])]); else if (s.trim()) out.push(s.trim());
  }
  return out.join("\n");
}
async function pptxToText(zip) {
  const names = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!names.length) throw new Error("파워포인트 슬라이드를 찾지 못함");
  const parts = [];
  for (let i = 0; i < names.length; i++) {
    const t = pptxSlide(await zip.file(names[i]).async("string"));
    parts.push(`[슬라이드 ${i + 1}]\n${t}`);
  }
  return { kind: "pptx", text: tidy(parts.join("\n\n")), notes: [] };
}

// buf → { kind, text, notes } / 이 모듈이 다루지 않는 형식이면 null / 읽다 실패하면 throw
async function fileToText(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (isPdf(buf)) return pdfToText(buf);
  if (isZip(buf)) {
    const zip = await JSZip.loadAsync(buf).catch(() => null);
    if (!zip) return null;
    if (zip.file("word/document.xml")) return docxToText(zip);
    if (zip.file("xl/workbook.xml")) return xlsxToText(zip);
    if (Object.keys(zip.files).some(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return pptxToText(zip);
  }
  const h = await hwp.hwpToText(buf);
  if (h) return { kind: h.kind, text: h.text, notes: [] };
  if (isOle(buf)) throw new Error("구형 오피스 형식(.doc·.xls·.ppt)은 읽지 못함 — 같은 내용의 PDF·HWP·새 형식(.docx·.xlsx) 첨부가 있으면 그쪽을 읽으세요");
  return null;
}

// PDF 쪽 그림(PNG) — 표 칸을 복원하지 못했을 때 눈으로 확인하는 다음 경로(2026-11-07). 한 번에 최대 3쪽.
async function renderPdfPages(buf, pages, scale) {
  const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buf), PDF_OPTS);
  const out = [];
  for (const p of pages.slice(0, 3)) {
    if (!Number.isInteger(p) || p < 1 || p > doc.numPages) { out.push({ page: p, error: `쪽 번호가 범위 밖(전체 ${doc.numPages}쪽)` }); continue; }
    const png = await renderPageAsImage(doc, p, { canvasImport: () => import("@napi-rs/canvas"), scale: scale || 1.5 });
    out.push({ page: p, png: Buffer.from(png) });
  }
  return { total: doc.numPages, images: out };
}

const KIND_LABEL = { pdf: "PDF 문서", docx: "워드 문서", xlsx: "엑셀 문서", pptx: "파워포인트 문서", hwp: "한글 문서", hwpx: "한글 문서" };

module.exports = { fileToText, isPdf, KIND_LABEL, renderTable, renderPdfPages, _test: { pdfToText, docxBody, xlsxToText, pptxSlide, colIndex, cellRef, serialToDate } };
