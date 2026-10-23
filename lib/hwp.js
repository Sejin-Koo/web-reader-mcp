// 한글 문서(HWP·HWPX)를 글로 바꾼다 — 본문 문단과 표(마크다운 표)를 순서대로.
//
// 왜: 공공기관 보도자료·법령 별표·서식은 첨부가 HWP인 경우가 대부분인데, 웹 읽기 도구(Tavily·Nimble)는
// HWP를 글로 바꾸지 못한다. 표가 본체(명단·금액·부과기준)인 문서가 많아 표를 셀 단위로 살려 낸다.
//
// HWP 5.x(OLE 복합문서): BodyText/Section* 스트림(압축이면 raw deflate)을 레코드로 읽는다.
//   레코드 머리 4바이트 = tagId(10비트)·level(10비트)·size(12비트, 0xFFF면 다음 4바이트가 크기).
//   문단 글자는 PARA_TEXT(UTF-16LE). 표는 CTRL_HEADER('tbl ') 아래 TABLE + 셀마다 LIST_HEADER(셀 주소·병합) + 문단들.
// HWPX(zip): Contents/section*.xml의 hp:p·hp:t·hp:tbl·hp:tc(hp:cellAddr·hp:cellSpan).
// 배포용·암호 문서는 본문이 암호화돼 읽지 않는다(사유를 돌려준다).

const zlib = require("zlib");
const CFB = require("cfb");
const JSZip = require("jszip");

const TAG = { PARA_HEADER: 66, PARA_TEXT: 67, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77 };

function isOle(buf) { return buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0; }
function isZip(buf) { return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04; }

function cleanCell(s) { return String(s || "").trim().replace(/\s*\n\s*/g, " / ").replace(/\|/g, "\\|").replace(/[ \t]+/g, " ").trim(); }

// grid: [{row, col, rowSpan, colSpan, text}], 병합된 칸은 왼쪽 위 칸에만 글을 두고 나머지는 비운다
function gridToMarkdown(cells, nRows, nCols) {
  if (!cells.length) return "";
  const R = Math.max(nRows || 0, ...cells.map(c => c.row + Math.max(1, c.rowSpan || 1)));
  let C = Math.max(nCols || 0, ...cells.map(c => c.col + Math.max(1, c.colSpan || 1)));
  if (R > 2000 || C > 100) return cells.map(c => cleanCell(c.text)).filter(Boolean).join("\n");
  const g = Array.from({ length: R }, () => Array(C).fill(""));
  for (const c of cells) if (c.row < R && c.col < C) g[c.row][c.col] = cleanCell(c.text);
  // 병합 때문에 생긴 빈 열은 뺀다(모든 행이 빈 열)
  const keep = []; for (let j = 0; j < C; j++) if (g.some(r => r[j])) keep.push(j);
  if (keep.length && keep.length < C) { for (let i = 0; i < R; i++) g[i] = keep.map(j => g[i][j]); C = keep.length; }
  if (C === 1) return g.map(r => r[0]).filter(Boolean).join("\n"); // 1열 표는 글상자처럼 쓰인 경우가 많다
  const lines = g.map(r => "| " + r.join(" | ") + " |");
  lines.splice(1, 0, "|" + Array(C).fill(" --- ").join("|") + "|");
  return lines.join("\n");
}

// ---------------- HWP 5.x ----------------
function readRecords(buf) {
  const recs = []; let p = 0;
  while (p + 4 <= buf.length) {
    const h = buf.readUInt32LE(p); p += 4;
    const tag = h & 0x3ff, level = (h >>> 10) & 0x3ff; let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) { if (p + 4 > buf.length) break; size = buf.readUInt32LE(p); p += 4; }
    if (p + size > buf.length) break;
    recs.push({ tag, level, data: buf.subarray(p, p + size) });
    p += size;
  }
  return recs;
}

// PARA_TEXT → 글. 제어문자: 확장·인라인 제어는 8 WCHAR, 문자 제어는 1 WCHAR
const EXT_INLINE = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
function paraText(data) {
  let out = ""; let i = 0; const n = Math.floor(data.length / 2);
  while (i < n) {
    const ch = data.readUInt16LE(i * 2);
    if (ch < 32) {
      if (EXT_INLINE.has(ch)) { if (ch === 9) out += "\t"; i += 8; continue; }
      if (ch === 10) out += "\n";
      else if (ch === 24) out += "-";
      else if (ch === 30 || ch === 31) out += " ";
      i += 1; continue;
    }
    out += String.fromCharCode(ch); i += 1;
  }
  return out;
}

function ctrlId(data) {
  if (data.length < 4) return "";
  const v = data.readUInt32LE(0);
  return String.fromCharCode((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

// 레코드 배열을 문단 단위로 걷는다. 표는 그 표가 들어 있는 문단 글 뒤에 둔다.
function walkParas(recs, start, end, baseLevel) {
  const out = [];
  let i = start;
  while (i < end) {
    const r = recs[i];
    if (r.tag === TAG.PARA_HEADER && r.level === baseLevel) {
      // 이 문단의 범위: 다음 같은 수준 PARA_HEADER(또는 더 얕은 레코드) 전까지
      let j = i + 1;
      while (j < end && !(recs[j].level <= baseLevel)) j++;
      let text = ""; const tables = [];
      for (let k = i + 1; k < j; k++) {
        const c = recs[k];
        if (c.tag === TAG.PARA_TEXT && c.level === baseLevel + 1) text += paraText(c.data);
        else if (c.tag === TAG.CTRL_HEADER && c.level === baseLevel + 1 && ctrlId(c.data) === "tbl ") {
          let m = k + 1; while (m < j && recs[m].level > c.level) m++;
          tables.push(readTable(recs, k + 1, m, c.level + 1));
          k = m - 1;
        }
      }
      const t = text.replace(/\r/g, "").trim();
      if (t) out.push(t);
      for (const tb of tables) if (tb) out.push(tb);
      i = j;
    } else i++;
  }
  return out;
}

function readTable(recs, start, end, lvl) {
  let nRows = 0, nCols = 0; const cells = [];
  for (let k = start; k < end; k++) {
    const r = recs[k];
    if (r.tag === TAG.TABLE && r.level === lvl && r.data.length >= 8) { nRows = r.data.readUInt16LE(4); nCols = r.data.readUInt16LE(6); }
    if (r.tag === TAG.LIST_HEADER && r.level === lvl) {
      // LIST_HEADER: 문단 수(2) · 여분(2) · 속성(4) · [셀] 열 주소(2) · 행 주소(2) · 열 병합(2) · 행 병합(2) · …
      // (실측 2026-10-23 법제처 별표 HWP 3건: 셀 주소는 8바이트 위치. pyhwp의 ListHeader 정의와 같다)
      const d = r.data;
      let addr = d.length >= 16 ? { col: d.readUInt16LE(8), row: d.readUInt16LE(10), colSpan: d.readUInt16LE(12), rowSpan: d.readUInt16LE(14) } : null;
      if (!addr || addr.colSpan < 1 || addr.rowSpan < 1 || addr.colSpan > 200 || addr.rowSpan > 2000) addr = { col: 0, row: cells.length, colSpan: 1, rowSpan: 1 };
      let m = k + 1; while (m < end && !(recs[m].tag === TAG.LIST_HEADER && recs[m].level === lvl) && recs[m].level >= lvl) m++;
      const text = walkParas(recs, k + 1, m, lvl).join("\n");
      cells.push({ ...addr, text });
      k = m - 1;
    }
  }
  return gridToMarkdown(cells, nRows, nCols);
}

function parseHwp5(buf) {
  const cfb = CFB.read(buf, { type: "buffer" });
  const header = CFB.find(cfb, "FileHeader");
  if (!header) throw new Error("HWP 파일 머리를 찾지 못함");
  const hb = Buffer.from(header.content);
  if (!hb.subarray(0, 17).toString("latin1").startsWith("HWP Document File")) throw new Error("HWP 형식이 아님");
  const props = hb.readUInt32LE(36);
  if (props & 2) throw new Error("암호가 걸린 문서라 읽을 수 없음");
  if (props & 4) throw new Error("배포용 문서(본문 암호화)라 읽을 수 없음");
  const compressed = !!(props & 1);
  const sections = cfb.FullPaths
    .map((p, i) => ({ p, e: cfb.FileIndex[i] }))
    .filter(x => /BodyText\/Section\d+$/i.test(x.p))
    .sort((a, b) => Number(a.p.match(/(\d+)$/)[1]) - Number(b.p.match(/(\d+)$/)[1]));
  if (!sections.length) throw new Error("본문 구역을 찾지 못함");
  const parts = [];
  for (const s of sections) {
    let data = Buffer.from(s.e.content);
    if (compressed) data = zlib.inflateRawSync(data);
    const recs = readRecords(data);
    parts.push(walkParas(recs, 0, recs.length, 0).join("\n\n"));
  }
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------- HWPX ----------------
function xmlUnescape(s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
function attr(tag, name) { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; }

function parseHwpxSection(xml) {
  const tok = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
  const stack = [{ kind: "root", text: "" }];
  const top = () => stack[stack.length - 1];
  const buf = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === "cell" || stack[i].kind === "root") return stack[i]; return stack[0]; };
  let inT = 0, m;
  while ((m = tok.exec(xml))) {
    if (m[5] !== undefined) { if (inT) buf().text += xmlUnescape(m[5]); continue; }
    const close = m[1] === "/", name = m[2].replace(/^\w+:/, ""), attrs = m[3], selfClose = m[4] === "/";
    if (name === "t") { if (!selfClose) inT += close ? -1 : 1; continue; }
    if (name === "tab" && !close) { buf().text += "\t"; continue; }
    if (name === "lineBreak" && !close) { buf().text += "\n"; continue; }
    if (name === "tbl") {
      if (!close) stack.push({ kind: "tbl", cells: [], rows: Number(attr(attrs, "rowCnt")) || 0, cols: Number(attr(attrs, "colCnt")) || 0 });
      else { const t = stack.pop(); if (t.kind === "tbl") { const md = gridToMarkdown(t.cells, t.rows, t.cols); const b = buf(); b.text += (b.text && !b.text.endsWith("\n") ? "\n" : "") + md + "\n"; } }
      continue;
    }
    if (name === "tc") {
      if (!close) stack.push({ kind: "cell", text: "", row: 0, col: 0, rowSpan: 1, colSpan: 1 });
      else { const c = stack.pop(); for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === "tbl") { stack[i].cells.push(c); break; } }
      continue;
    }
    if (name === "cellAddr" && top().kind === "cell") { top().col = Number(attr(attrs, "colAddr")) || 0; top().row = Number(attr(attrs, "rowAddr")) || 0; continue; }
    if (name === "cellSpan" && top().kind === "cell") { top().colSpan = Number(attr(attrs, "colSpan")) || 1; top().rowSpan = Number(attr(attrs, "rowSpan")) || 1; continue; }
    if (name === "p" && close) { const b = buf(); if (!b.text.endsWith("\n")) b.text += "\n"; }
  }
  return stack[0].text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function parseHwpx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const mt = zip.file("mimetype");
  const mime = mt ? (await mt.async("string")).trim() : "";
  const names = Object.keys(zip.files).filter(n => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/i)[1]) - Number(b.match(/(\d+)\.xml$/i)[1]));
  if (!names.length) throw new Error(mime ? `한글 문서 본문을 찾지 못함(${mime})` : "HWPX 형식이 아님");
  const parts = [];
  for (const n of names) parts.push(parseHwpxSection(await zip.file(n).async("string")));
  return parts.join("\n\n").trim();
}

// buf → { kind: "hwp" | "hwpx", text } / 한글 문서가 아니면 null
async function hwpToText(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (isOle(buf)) {
    let cfbOk = false;
    try { const c = CFB.read(buf, { type: "buffer" }); cfbOk = !!CFB.find(c, "FileHeader"); } catch (e) { cfbOk = false; }
    if (!cfbOk) return null; // 한글이 아닌 OLE 문서(구형 doc·xls 등)
    return { kind: "hwp", text: parseHwp5(buf) };
  }
  if (isZip(buf)) {
    const zip = await JSZip.loadAsync(buf).catch(() => null);
    if (!zip) return null;
    const mt = zip.file("mimetype");
    const mime = mt ? (await mt.async("string")).trim() : "";
    if (!/hwp/i.test(mime) && !Object.keys(zip.files).some(n => /^Contents\/section\d+\.xml$/i.test(n))) return null;
    return { kind: "hwpx", text: await parseHwpx(buf) };
  }
  return null;
}

module.exports = { hwpToText, _test: { parseHwp5, parseHwpx, parseHwpxSection, gridToMarkdown, paraText } };
