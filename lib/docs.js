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
const gridToMarkdown = hwp._test.gridToMarkdown;

const MAX_PDF_PAGES = 300;
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
async function pdfToText(buf) {
  const { getDocumentProxy } = await import("unpdf");
  let doc;
  try { doc = await getDocumentProxy(new Uint8Array(buf)); }
  catch (e) { throw new Error(/password/i.test(e.message || "") ? "암호가 걸린 PDF라 읽을 수 없음" : `PDF를 열지 못함(${(e.message || "").slice(0, 80)})`); }
  const nPages = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pages = [];
  for (let p = 1; p <= nPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it || typeof it.str !== "string" || !it.str.length) continue;
      const fs = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10;
      items.push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, fs });
    }
    // 같은 높이(글자 크기의 절반 이내)는 한 줄
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const L = lines.length ? lines[lines.length - 1] : null;
      if (L && Math.abs(L.y - it.y) <= Math.max(2, Math.min(L.fs, it.fs) * 0.5)) L.items.push(it);
      else lines.push({ y: it.y, fs: it.fs, items: [it] });
    }
    const out = [];
    for (const L of lines) {
      L.items.sort((a, b) => a.x - b.x);
      let s = "", end = null;
      for (const it of L.items) {
        const blank = !it.s.trim();
        if (end !== null) {
          const gap = it.x - end;
          if (gap > it.fs * 2.2 && !blank) s = s.replace(/\s+$/, "") + " | ";
          else if (gap > it.fs * 0.15 && !/\s$/.test(s) && !blank) s += " ";
        }
        s += blank ? (/\s$/.test(s) ? "" : " ") : it.s;
        end = Math.max(end === null ? -Infinity : end, it.x + it.w);
      }
      s = s.replace(/[ \t ]+/g, " ").trim();
      if (s) out.push(s);
    }
    pages.push(out);
  }
  // 여러 쪽에 되풀이되는 줄(머리말·꼬리말·쪽 번호)은 뺀다 — 숫자를 지운 모양이 쪽의 절반 이상에 나오면
  const norm = s => s.replace(/\d+/g, "#").replace(/\s+/g, "");
  const drop = new Set();
  if (pages.length >= 3) {
    const cnt = new Map();
    pages.forEach(ls => new Set(ls.map(norm)).forEach(k => cnt.set(k, (cnt.get(k) || 0) + 1)));
    cnt.forEach((n, k) => { if (n >= Math.max(3, Math.ceil(pages.length / 2)) && k.length <= 120) drop.add(k); });
  }
  const pageNo = /^[-–—\s]*\d{1,4}[-–—\s]*$|^\d{1,4}\s*\/\s*\d{1,4}$/;
  const parts = pages.map((ls, i) => {
    const kept = ls.filter(s => !drop.has(norm(s)) && !pageNo.test(s));
    return kept.length ? `[쪽 ${i + 1}]\n` + kept.join("\n") : "";
  }).filter(Boolean);
  const text = tidy(parts.join("\n\n"));
  const letters = text.replace(/\[쪽 \d+\]/g, "").replace(/[\s|]/g, "").length;
  if (letters < 20 * Math.max(1, Math.min(nPages, 5)) && letters < 200) throw new Error("글자가 없는 PDF(스캔 이미지로 보임)");
  const notes = [];
  if (doc.numPages > nPages) notes.push(`전체 ${doc.numPages}쪽 중 앞 ${nPages}쪽만 읽음`);
  if (drop.size) notes.push(`여러 쪽에 되풀이되는 머리말·꼬리말 ${drop.size}줄은 뺌`);
  return { kind: "pdf", text, notes };
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

const KIND_LABEL = { pdf: "PDF 문서", docx: "워드 문서", xlsx: "엑셀 문서", pptx: "파워포인트 문서", hwp: "한글 문서", hwpx: "한글 문서" };

module.exports = { fileToText, isPdf, KIND_LABEL, renderTable, _test: { pdfToText, docxBody, xlsxToText, pptxSlide, colIndex, cellRef, serialToDate } };
