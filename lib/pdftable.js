// PDF 표 칸 복원 — 테두리선으로 격자를 짜고 글자 조각을 좌표대로 칸에 넣는다(Camelot·Tabula의 lattice 방식과 같은 원리).
//
// 왜(2026-11-07): 종전 PDF 변환은 같은 높이의 글자를 한 줄로 묶기만 해, 한 칸에 두 줄 이상 든 표에서 옆 칸 글이 섞였다
//   (금융위 보도자료 붙임 표: "④ 이사회 / 채택 여부 / 전문성, 독립성"). 한글(HWP)에서 만든 PDF는 표 테두리를 선·가는 사각형으로
//   그려 두므로 그 선으로 칸을 다시 짤 수 있다.
//
// 흐름(쪽마다)
//   1) 연산 목록에서 그리기 경로를 읽어 가로·세로 선분을 모은다(가는 사각형은 선, 큰 사각형은 네 변). 좌표 변환 행렬을 따라간다.
//   2) 같은 높이(너비)의 선분을 이어 붙이고, 서로 닿는 선분끼리 묶어 표 후보를 만든다.
//   3) 가로선 높이·세로선 위치로 기본 칸을 만들고, 칸 사이 경계선이 없으면 병합 칸으로 본다.
//   4) 글자 조각의 가운데 점으로 칸을 찾아 넣는다.
//   5) 점검: 경계선에 걸친 글자, 칸 밖으로 크게 넘친 글자가 있으면 그 표는 '복원 실패'로 표시한다(그대로 쓰지 않게).

const TOL = 1.5;
// 값 하나로 보이는 숫자 조각(천 단위 쉼표·소수·괄호 음수·%·부호). 한 칸 안에 이런 조각 둘이 크게 떨어져 있으면 숨은 열이다.
// (연락처 표의 "과 장 | 박범수 (044-…)"처럼 글과 숫자가 떨어진 것은 숨은 열로 보지 않는다 — 읽기에 지장이 없다)
const NUMV = /^[-–−+(△▲▼▽]?[\d][\d,.]*(%p?|‰)?[↑↓▲▼]?\)?[↑↓]?$/;

function mul(a, b) { // 3x2 행렬 곱 (a 다음 b)
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// 연산 목록 → 가로·세로 선분 [{x1,x2,y}] / [{y1,y2,x}]
function collectSegments(ol, OPS, pageW, pageH) {
  const H = [], V = [];
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
  const PAINT = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const addSeg = (x1, y1, x2, y2) => {
    if (Math.abs(y1 - y2) <= 1 && Math.abs(x2 - x1) > 2) H.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 });
    else if (Math.abs(x1 - x2) <= 1 && Math.abs(y2 - y1) > 2) V.push({ y1: Math.min(y1, y2), y2: Math.max(y1, y2), x: (x1 + x2) / 2 });
  };
  const addRect = (pts) => {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
    const w = x2 - x1, h = y2 - y1;
    if (w >= pageW * 0.95 && h >= pageH * 0.9) return; // 쪽 테두리·배경
    if (h <= 2.5 && w > 2) { H.push({ x1, x2, y: (y1 + y2) / 2 }); return; }
    if (w <= 2.5 && h > 2) { V.push({ y1, y2, x: (x1 + x2) / 2 }); return; }
    if (w > 2 && h > 2) { H.push({ x1, x2, y: y1 }, { x1, x2, y: y2 }); V.push({ y1, y2, x: x1 }, { y1, y2, x: x2 }); }
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === OPS.save) { stack.push(ctm); continue; }
    if (fn === OPS.restore) { ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
    if (fn === OPS.transform) { ctm = mul(a, ctm); continue; }
    if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a && a[0]) ctm = mul(a[0], ctm); continue; }
    if (fn === OPS.paintFormXObjectEnd) { ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
    if (fn !== OPS.constructPath) continue;
    const paint = a[0];
    if (!PAINT.has(paint)) continue; // 클립 전용 경로는 제외
    const data = a[1] && a[1][0] ? a[1][0] : null;
    if (!data) continue;
    // 경로 데이터: 0 moveTo x y / 1 lineTo x y / 2 curveTo 6수 / 3 quadraticCurveTo 4수 / 4 closePath
    let sub = [], curved = false;
    const flush = () => {
      if (sub.length >= 2 && !curved) {
        const axis = sub.every((p, k) => k === 0 || Math.abs(p[0] - sub[k - 1][0]) <= 1 || Math.abs(p[1] - sub[k - 1][1]) <= 1);
        if (sub.length >= 4 && axis && (sub.length <= 5)) addRect(sub);
        else for (let k = 1; k < sub.length; k++) addSeg(sub[k - 1][0], sub[k - 1][1], sub[k][0], sub[k][1]);
      }
      sub = []; curved = false;
    };
    for (let k = 0; k < data.length;) {
      const op = data[k];
      if (op === 0) { flush(); sub.push(apply(ctm, data[k + 1], data[k + 2])); k += 3; }
      else if (op === 1) { sub.push(apply(ctm, data[k + 1], data[k + 2])); k += 3; }
      else if (op === 2) { curved = true; k += 7; }
      else if (op === 3) { curved = true; k += 5; }
      else if (op === 4) { if (sub.length) sub.push(sub[0]); flush(); k += 1; }
      else break;
    }
    flush();
  }
  return { H, V };
}

// 같은 높이의 가로선(같은 x의 세로선)을 이어 붙인다
function mergeLines(segs, key, a, b) {
  let cur = segs.map(s => Object.assign({}, s)), changed = true;
  while (changed) {
    changed = false;
    cur.sort((p, q) => p[key] - q[key] || p[a] - q[a]);
    const out = [];
    for (const s of cur) {
      const o = out.find(o => Math.abs(o[key] - s[key]) <= TOL && s[a] <= o[b] + 2 && s[b] >= o[a] - 2);
      if (o) { o[a] = Math.min(o[a], s[a]); o[b] = Math.max(o[b], s[b]); o[key] = (o[key] + s[key]) / 2; changed = true; }
      else out.push(s);
    }
    cur = out;
  }
  return cur;
}

const cluster = (vals) => { const s = vals.slice().sort((p, q) => p - q); const out = []; for (const v of s) { if (out.length && v - out[out.length - 1].v <= TOL * 1.5) { const c = out[out.length - 1]; c.sum += v; c.n++; c.v = c.sum / c.n; } else out.push({ v, sum: v, n: 1 }); } return out.map(c => c.v); };

// 선분 → 표 후보(서로 닿는 선분 묶음)
function findTables(H, V) {
  const nodes = H.map(h => ({ t: "h", s: h })).concat(V.map(v => ({ t: "v", s: v })));
  const parent = nodes.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const touch = (h, v) => v.x >= h.x1 - 2 && v.x <= h.x2 + 2 && h.y >= v.y1 - 2 && h.y <= v.y2 + 2;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const A = nodes[i], B = nodes[j];
    if (A.t === B.t) continue;
    const h = A.t === "h" ? A.s : B.s, v = A.t === "v" ? A.s : B.s;
    if (touch(h, v)) parent[find(i)] = find(j);
  }
  const groups = new Map();
  nodes.forEach((n, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, { H: [], V: [] }); groups.get(r)[n.t === "h" ? "H" : "V"].push(n.s); });
  return [...groups.values()].filter(g => g.H.length >= 2 && g.V.length >= 2);
}

// 표 후보 하나 → 칸 격자
function buildGrid(g) {
  const ys = cluster(g.H.map(h => h.y)).sort((p, q) => q - p); // 위에서 아래로
  const xs = cluster(g.V.map(v => v.x)).sort((p, q) => p - q);
  if (ys.length < 2 || xs.length < 2) return null;
  const R = ys.length - 1, C = xs.length - 1;
  if (R > 400 || C > 60) return null;
  const covH = (y, xa, xb) => { // y 높이에서 [xa,xb] 구간이 가로선으로 덮인 비율
    let cov = 0; const L = xb - xa; if (L <= 0) return 1;
    for (const h of g.H) if (Math.abs(h.y - y) <= TOL * 1.5) cov += Math.max(0, Math.min(xb, h.x2) - Math.max(xa, h.x1));
    return Math.min(1, cov / L);
  };
  const covV = (x, ya, yb) => {
    let cov = 0; const L = yb - ya; if (L <= 0) return 1;
    for (const v of g.V) if (Math.abs(v.x - x) <= TOL * 1.5) cov += Math.max(0, Math.min(yb, v.y2) - Math.max(ya, v.y1));
    return Math.min(1, cov / L);
  };
  // 기본 칸 병합(union-find)
  const id = (r, c) => r * C + c;
  const par = Array.from({ length: R * C }, (_, i) => i);
  const f = i => par[i] === i ? i : (par[i] = f(par[i]));
  const uni = (a, b) => { par[f(a)] = f(b); };
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (c + 1 < C && covV(xs[c + 1], ys[r + 1], ys[r]) < 0.5) uni(id(r, c), id(r, c + 1));
    if (r + 1 < R && covH(ys[r + 1], xs[c], xs[c + 1]) < 0.5) uni(id(r, c), id(r + 1, c));
  }
  const cells = new Map();
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const k = f(id(r, c));
    if (!cells.has(k)) cells.set(k, { r0: r, r1: r, c0: c, c1: c, n: 0 });
    const m = cells.get(k); m.r0 = Math.min(m.r0, r); m.r1 = Math.max(m.r1, r); m.c0 = Math.min(m.c0, c); m.c1 = Math.max(m.c1, c); m.n++;
  }
  const list = [...cells.values()];
  // 병합 칸이 직사각형이 아니면(ㄱ자 등) 격자를 믿지 않는다
  const irregular = list.some(m => (m.r1 - m.r0 + 1) * (m.c1 - m.c0 + 1) !== m.n);
  return { xs, ys, R, C, cells: list.map(m => ({ row: m.r0, col: m.c0, rowSpan: m.r1 - m.r0 + 1, colSpan: m.c1 - m.c0 + 1, x1: xs[m.c0], x2: xs[m.c1 + 1], y1: ys[m.r1 + 1], y2: ys[m.r0], items: [] })), irregular, bbox: { x1: xs[0], x2: xs[C], y1: ys[R], y2: ys[0] } };
}

// 칸 안 글자 조각 → 줄 [{y, text}]
function cellLines(items) {
  items = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const L = lines.length ? lines[lines.length - 1] : null;
    if (L && Math.abs(L.y - it.y) <= Math.max(2, it.fs * 0.5)) L.items.push(it); else lines.push({ y: it.y, fs: it.fs, items: [it] });
  }
  return lines.map(L => { L.items.sort((a, b) => a.x - b.x); let s = "", end = null; for (const it of L.items) { if (end !== null && it.x - end > it.fs * 0.15 && !/\s$/.test(s)) s += " "; s += it.s; end = it.x + it.w; } return { y: L.y, fs: L.fs, text: s.replace(/\s+/g, " ").trim() }; }).filter(l => l.text);
}

// 가로 테두리 없이 여러 행이 한 칸 줄에 들어간 경우(일정표 등) 나눈다.
// 기준 칸: 줄이 가장 많은 칸. 그 줄들 중 60% 이상이 같은 높이에 다른 칸의 줄과 맞으면 행 경계로 본다.
// 다른 칸의 줄은 그 줄 바로 위(같거나 높은)의 기준 줄 행으로 넣는다(자동 줄넘김 줄은 앞 행에 붙는다).
function splitRows(grid) {
  const out = []; let splitCount = 0, ambiguous = 0;
  const byRow = new Map();
  grid.cells.forEach(c => { if (!byRow.has(c.row)) byRow.set(c.row, []); byRow.get(c.row).push(c); });
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  let shift = 0; const rowMap = new Map(); // 원래 행 → 새 시작 행
  const pieces = [];
  for (const r of rows) {
    const cells = byRow.get(r);
    const lines = cells.map(c => cellLines(c.items));
    const simple = cells.every(c => c.rowSpan === 1);
    let starts = null;
    // 줄 높이 띠: 두 칸 이상에 같은 높이로 나오는 줄 높이. 숫자가 든 띠가 2개 이상이면 테두리 없는 하위 행 후보
    // (머리글 칸의 여러 줄 제목은 숫자가 없어 나누지 않는다)
    const all = []; lines.forEach((ls, i) => ls.forEach(l => all.push({ y: l.y, fs: l.fs, i, d: /\d/.test(l.text) })));
    const tol = l => Math.max(2, l.fs * 0.5);
    const bands = [];
    for (const l of all.slice().sort((a, b) => b.y - a.y)) {
      const b = bands.find(b => Math.abs(b.y - l.y) <= tol(l));
      if (b) { b.cells.add(l.i); if (l.d) b.d = true; } else bands.push({ y: l.y, cells: new Set([l.i]), d: l.d });
    }
    const real = bands.filter(b => b.cells.size >= 2);
    const digitBands = real.filter(b => b.d).length;
    if (!simple && digitBands >= 2) { ambiguous++; } // 병합 칸이 걸친 행에 숫자 하위 행이 여럿 — 확실히 나눌 수 없다
    if (simple) {
      // 모든 줄이 띠에 맞고, 같은 모양의 숫자 줄이 둘 이상 쌓인 칸(값 열)이 있으면 하위 행이 분명하다(일본 결산단신 등).
      // "13:20~13:40"/"(20분)"처럼 모양이 다른 줄만 쌓인 일정표 행은 한 행의 두 줄이라 나누지 않는다.
      const shape = t => t.replace(/\d+/g, "#").replace(/\s+/g, "");
      const valueCol = lines.some(ls => { const d = ls.filter(l => /\d/.test(l.text)); return d.length >= 2 && d.every(l => shape(l.text) === shape(d[0].text)); });
      if (real.length >= 2 && valueCol) {
        const unaligned = all.filter(l => !real.some(b => Math.abs(b.y - l.y) <= tol(l))).length;
        if (!unaligned) starts = real.map(b => b.y).sort((a, b) => b - a);
      }
      if (!starts) {
        // 기준 칸: 다른 칸 줄과 같은 높이에 맞는 줄이 가장 많은 칸(같으면 줄이 적은 칸 — 자동 줄넘김이 적은 쪽)
        let best = null;
        lines.forEach((anchor, ai) => {
          if (anchor.length < 2) return;
          const aligned = anchor.filter(al => lines.some((ls, i) => i !== ai && ls.length >= 2 && ls.some(l => Math.abs(l.y - al.y) <= Math.max(2, al.fs * 0.5)))).length;
          if (aligned >= 2 && aligned >= anchor.length * 0.6 && (!best || aligned > best.aligned || (aligned === best.aligned && anchor.length < best.n))) best = { ai, aligned, n: anchor.length };
        });
        // 기준 칸 줄들이 같은 모양(숫자만 다른 시각·번호·연도)일 때만 행 경계로 본다.
        // "13:20~13:40"과 "(20분)"처럼 모양이 다르면 한 행의 두 줄이다(2026-11-07 실측: 농진청 일정표).
        if (best) {
          const shape = t => t.replace(/\d+/g, "#").replace(/\s+/g, "");
          const sh = lines[best.ai].map(l => shape(l.text));
          const top = Math.max(...[...new Set(sh)].map(x => sh.filter(y => y === x).length));
          if (top >= sh.length * 0.8) starts = lines[best.ai].map(l => l.y);
          else if (best.aligned >= 3 && all.filter(l => l.d).length >= 2) ambiguous++; // 숫자 없는 여러 줄 제목은 나누지 않아도 값이 섞이지 않는다
        }
      }
    }
    rowMap.set(r, r + shift);
    if (!starts) { cells.forEach((c, i) => pieces.push({ row: r + shift, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, text: lines[i].map(l => l.text).join(" ") })); continue; }
    splitCount++;
    const k = starts.length;
    cells.forEach((c, i) => {
      const buckets = Array.from({ length: k }, () => []);
      for (const l of lines[i]) {
        // 가장 가까운 기준 줄의 행(칸 안 세로 가운데 맞춤이면 줄넘김 줄이 기준 줄 위아래로 갈린다)
        let b = 0, d = Infinity; for (let j = 0; j < k; j++) { const dj = Math.abs(starts[j] - l.y); if (dj < d) { d = dj; b = j; } }
        buckets[b].push(l.text);
      }
      buckets.forEach((t, j) => pieces.push({ row: r + shift + j, col: c.col, rowSpan: 1, colSpan: c.colSpan, text: t.join(" ") }));
    });
    shift += k - 1;
  }
  // 위쪽 행에서 내려오는 병합 칸(rowSpan>1)은 늘어난 행 수만큼 넓힌다
  pieces.forEach(p => {
    if (p.rowSpan > 1) {
      const orig = [...rowMap.entries()].find(([o, n]) => n === p.row);
      if (orig) { const endOrig = orig[0] + p.rowSpan; const endNew = rowMap.has(endOrig) ? rowMap.get(endOrig) : grid.R + shift; p.rowSpan = endNew - p.row; }
    }
  });
  return { cells: pieces, R: grid.R + shift, split: splitCount, ambiguous };
}

// 칸 안 글자 조각 → 글(위→아래, 왼→오른, 줄은 ' / '가 아니라 공백으로 — 칸 안 줄바꿈은 대개 자동 줄넘김)
function cellText(items) {
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const L = lines.length ? lines[lines.length - 1] : null;
    if (L && Math.abs(L.y - it.y) <= Math.max(2, it.fs * 0.5)) L.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  return lines.map(L => { L.items.sort((a, b) => a.x - b.x); let s = "", end = null; for (const it of L.items) { if (end !== null && it.x - end > it.fs * 0.15 && !/\s$/.test(s)) s += " "; s += it.s; end = it.x + it.w; } return s.replace(/\s+/g, " ").trim(); }).filter(Boolean)
    .join(" "); // 한글 문서의 칸 안 줄넘김은 대개 어절 단위라 공백으로 잇는다
}

// 쪽 하나: 표 찾기 → 글자 배정 → 점검. 반환 { tables:[{bbox, cells, ok, why}], used:Set(글자 조각 번호) }
function pageTables(ol, OPS, items, pageW, pageH) {
  const { H, V } = collectSegments(ol, OPS, pageW, pageH);
  if (H.length < 2 || V.length < 2) return { tables: [], used: new Set() };
  const Hm = mergeLines(H, "y", "x1", "x2"), Vm = mergeLines(V, "x", "y1", "y2");
  const out = []; const used = new Set();
  for (const g of findTables(Hm, Vm)) {
    const grid = buildGrid(g);
    if (!grid) continue;
    const bb = Object.assign({}, grid.bbox);
    if (bb.x2 - bb.x1 < 30 || bb.y2 - bb.y1 < 10) continue;
    // 가로선이 세로선 범위보다 넓게 뻗어 있으면 테두리가 일부 열에만 있는 표다(지멘스 실적표: 항목 열에 세로선 없음).
    // 이때 격자만 쓰면 항목명이 표 밖으로 떨어져 숫자만 남으므로, 가로선 끝까지 표 영역을 넓히고 '복원 실패'로 표시한다.
    const hx1 = Math.min(...g.H.map(h => h.x1)), hx2 = Math.max(...g.H.map(h => h.x2));
    const partial = hx1 < bb.x1 - 5 || hx2 > bb.x2 + 5;
    if (partial) { bb.x1 = Math.min(bb.x1, hx1); bb.x2 = Math.max(bb.x2, hx2); }
    // 표 안 글자 조각
    const inside = [];
    items.forEach((it, i) => {
      const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3;
      if (cx >= bb.x1 - 1 && cx <= bb.x2 + 1 && cy >= bb.y1 - 1 && cy <= bb.y2 + 1) inside.push(i);
    });
    if (!inside.length) continue;
    let onBorder = 0, overflow = 0;
    for (const i of inside) {
      const it = items[i]; const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3;
      const cell = grid.cells.find(c => cx >= c.x1 && cx <= c.x2 && cy >= c.y1 && cy <= c.y2);
      if (!cell) { onBorder++; continue; }
      if (it.x < cell.x1 - it.fs * 0.8 || it.x + it.w > cell.x2 + it.fs * 0.8) overflow++;
      cell.items.push(it); used.add(i);
    }
    const sp = splitRows(grid);
    const cells = sp.cells;
    const filled = cells.filter(c => c.text);
    const realCols = new Set(filled.map(c => c.col)).size, realRows = new Set(filled.map(c => c.row)).size;
    let ok = true, why = "";
    // 한 칸 안에서 같은 줄 글자 사이가 크게 벌어졌으면 세로선 없는 열이 칸 안에 숨어 있다
    const hiddenCols = grid.cells.some(c => cellLines(c.items).length && (() => {
      const its = c.items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
      for (let k = 1; k < its.length; k++) { const a = its[k - 1], b = its[k]; if (Math.abs(a.y - b.y) <= Math.max(2, b.fs * 0.5) && b.x - (a.x + a.w) > b.fs * 2.2 && NUMV.test(a.s.trim()) && NUMV.test(b.s.trim())) return true; }
      return false;
    })());
    if (partial) { ok = false; why = "표 테두리가 일부 열에만 있어 항목명과 값을 같은 칸으로 묶지 못함"; }
    else if (hiddenCols) { ok = false; why = "세로 테두리 없는 열이 칸 안에 섞여 있음"; }
    else if (grid.irregular) { ok = false; why = "병합 칸 모양이 직사각형이 아님"; }
    else if (sp.ambiguous) { ok = false; why = "가로 테두리 없이 여러 행이 한 칸에 든 것으로 보이나 행을 확실히 나누지 못함"; }
    else if (onBorder > Math.max(1, inside.length * 0.03)) { ok = false; why = `경계선에 걸친 글자 ${onBorder}개`; }
    else if (overflow > Math.max(1, inside.length * 0.03)) { ok = false; why = `칸 밖으로 넘친 글자 ${overflow}개`; }
    out.push({ bbox: bb, cells, R: sp.R, C: grid.C, ok, why, split: sp.split, box: realCols <= 1 || realRows <= 1 });
  }
  return { tables: out, used };
}

module.exports = { pageTables, cellText, _test: { splitRows, cellLines, collectSegments, mergeLines, findTables, buildGrid, cluster } };
