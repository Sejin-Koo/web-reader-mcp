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
  const H = [], V = [], Hd = [], Vd = []; // Hd·Vd: 점선·파선의 짧은 조각(나중에 이어 붙여 선으로)
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
  const PAINT = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const addSeg = (x1, y1, x2, y2) => {
    if (Math.abs(y1 - y2) <= 1 && Math.abs(x2 - x1) > 2) H.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 });
    else if (Math.abs(x1 - x2) <= 1 && Math.abs(y2 - y1) > 2) V.push({ y1: Math.min(y1, y2), y2: Math.max(y1, y2), x: (x1 + x2) / 2 });
    else if (Math.abs(y1 - y2) <= 0.3 && Math.abs(x2 - x1) > 0.05) Hd.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 });
    else if (Math.abs(x1 - x2) <= 0.3 && Math.abs(y2 - y1) > 0.05) Vd.push({ y1: Math.min(y1, y2), y2: Math.max(y1, y2), x: (x1 + x2) / 2 });
  };
  const addRect = (pts) => {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
    const w = x2 - x1, h = y2 - y1;
    if (w >= pageW * 0.95 && h >= pageH * 0.9) return; // 쪽 테두리·배경
    if (h <= 2.5 && w > 2) { H.push({ x1, x2, y: (y1 + y2) / 2 }); return; }
    if (w <= 2.5 && h > 2) { V.push({ y1, y2, x: (x1 + x2) / 2 }); return; }
    if (w > 2 && h > 2) { H.push({ x1, x2, y: y1 }, { x1, x2, y: y2 }); V.push({ y1, y2, x: x1 }, { y1, y2, x: x2 }); return; }
    if (w <= 2.5 && h <= 2.5 && (w > 0.05 || h > 0.05)) { if (w >= h) Hd.push({ x1, x2, y: (y1 + y2) / 2 }); else Vd.push({ y1, y2, x: (x1 + x2) / 2 }); } // 점선의 점
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
  // 점선·파선(HWP 표의 칸 구분 점선은 0.5pt 안팎 조각 수백 개로 그려짐): 같은 높이에서 3.5pt 이내 간격으로 5조각 이상 이어지고
  // 길이가 12pt 이상이면 선 하나로 본다(실측 2026-11-07: 보건복지부 일정표 점선 2,882조각 → 버려져 행이 합쳐짐)
  const chain = (ds, key, a, b, out) => {
    const by = new Map();
    for (const d of ds) { const k = Math.round(d[key] * 2) / 2; if (!by.has(k)) by.set(k, []); by.get(k).push(d); }
    for (const list of by.values()) {
      list.sort((p, q) => p[a] - q[a]);
      let cur = null;
      const end = () => { if (cur && cur.n >= 5 && cur[b] - cur[a] >= 12) out.push({ [a]: cur[a], [b]: cur[b], [key]: cur[key], dash: true }); };
      for (const d of list) {
        if (cur && d[a] - cur[b] <= 3.5) { cur[b] = Math.max(cur[b], d[b]); cur.n++; }
        else { end(); cur = { [a]: d[a], [b]: d[b], [key]: d[key], n: 1 }; }
      }
      end();
    }
  };
  chain(Hd, "y", "x1", "x2", H); chain(Vd, "x", "y1", "y2", V);
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
      if (o) { o[a] = Math.min(o[a], s[a]); o[b] = Math.max(o[b], s[b]); o[key] = (o[key] + s[key]) / 2; o.dash = !!(o.dash && s.dash); changed = true; }
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

// 밑줄형 표(BMW 분기보고서): 세로선 없이 칸마다 따로 밑줄만 그은 표. 같은 x 구간의 밑줄 3개 이상이 3행 이상 같은 모양으로
// 쌓이면 밑줄 사이 틈을 열 경계로, 밑줄 높이를 행 경계로 보아 격자 후보를 만든다(맨 윗행은 밑줄 간격만큼 위로).
function findUnderlineTables(H, avoid) {
  // 같은 높이의 밑줄을 x 순으로 놓고, 틈이 10pt 이하로 이어지는 3개 이상 묶음(run)을 한 행 후보로 본다.
  // 틈이 더 넓으면 다른 표다(옆 단 목차 밑줄·나란히 놓인 두 표 — 2026-11-07 BMW 14쪽 실측: 목차와 두 표가 한 표로 묶임).
  const rows = [];
  for (const h of H.filter(h => h.x2 - h.x1 >= 8).sort((p, q) => q.y - p.y || p.x1 - q.x1)) {
    const r = rows.find(r => Math.abs(r.y - h.y) <= 1);
    if (r) r.segs.push(h); else rows.push({ y: h.y, segs: [h] });
  }
  const runs = [];
  for (const r of rows) {
    r.segs.sort((p, q) => p.x1 - q.x1);
    const segs = r.segs.filter((sg, i) => i === 0 || sg.x1 > r.segs[i - 1].x2 - 1);
    let run = [];
    const end = () => { runs.push({ y: r.y, segs: run, ok: run.length >= 3 }); run = []; };
    for (const sg of segs) { if (run.length && (sg.x1 - run[run.length - 1].x2 > 10 || sg.x1 - run[run.length - 1].x2 < 1)) end(); run.push(sg); }
    if (run.length) end();
  }
  const same = (a, b) => a.segs.length === b.segs.length && a.segs.every((sg, i) => Math.abs(sg.x1 - b.segs[i].x1) <= 3 && Math.abs(sg.x2 - b.segs[i].x2) <= 3);
  const span = g => ({ L: g.rows[0].segs[0].x1, R: g.rows[0].segs[g.rows[0].segs.length - 1].x2 });
  const open = [], done = [];
  for (const run of runs.sort((p, q) => q.y - p.y || p.segs[0].x1 - q.segs[0].x1)) {
    // 오래 이어지지 않은 묶음은 닫는다
    for (let i = open.length - 1; i >= 0; i--) if (open[i].rows[open[i].rows.length - 1].y - run.y > 45) done.push(open.splice(i, 1)[0]);
    const g = run.ok ? open.find(g => same(g.rows[g.rows.length - 1], run)) : null;
    if (g) { g.rows.push(run); continue; }
    // 묶음의 가로 범위에 겹치는 다른 모양의 선이 나오면 그 묶음은 끝난다
    for (let i = open.length - 1; i >= 0; i--) { const sp = span(open[i]); if (run.segs.some(sg => sg.x2 > sp.L + 2 && sg.x1 < sp.R - 2)) done.push(open.splice(i, 1)[0]); }
    if (run.ok) open.push({ rows: [run] });
  }
  done.push(...open);
  const out = [];
  for (const g of done) {
    if (g.rows.length < 3) continue;
    const ys = g.rows.map(r => r.y);
    const gaps = ys.slice(1).map((y, i) => ys[i] - y).sort((p, q) => p - q);
    const rowH = gaps[Math.floor(gaps.length / 2)];
    const segs = g.rows[0].segs;
    const x1 = segs[0].x1, x2 = segs[segs.length - 1].x2, top = ys[0] + rowH, bot = ys[ys.length - 1];
    const box = { x1, x2, y1: bot, y2: top };
    if (avoid.some(b => b.x1 < box.x2 && b.x2 > box.x1 && b.y1 < box.y2 && b.y2 > box.y1)) continue;
    const xs = [x1].concat(segs.slice(1).map((sg, i) => (segs[i].x2 + sg.x1) / 2), [x2]);
    out.push({ ul: true, H: [top].concat(ys).map(y => ({ x1, x2, y })), V: xs.map(x => ({ x, y1: bot, y2: top })) });
  }
  return out;
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
        const un = all.filter(l => !real.some(b => Math.abs(b.y - l.y) <= tol(l)));
        const topBand = Math.max(...real.map(b => b.y));
        if (!un.length) starts = real.map(b => b.y).sort((a, b) => b - a);
        // 띠보다 위에 숫자 없는 줄만 남으면(도요타 세그먼트 표의 "営業収益" 위 제목 줄) 그 줄을 따로 한 행으로 둔다
        else if (un.every(l => !l.d && l.y > topBand + tol(l))) starts = real.map(b => b.y).concat(cluster(un.map(l => l.y))).sort((a, b) => b - a);
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
    // 나누지 못했는데 한 칸에 값만 있는 줄이 둘 이상 쌓여 있으면 하위 행이 합쳐진 것이다(값이 한 칸에 붙어 나가지 않게)
    const valLine = t => { const tk = t.split(/\s+/).filter(Boolean); return tk.length > 0 && tk.every(x => NUMV.test(x) || /^[－—–-]$/.test(x)) && tk.some(x => NUMV.test(x)); };
    if (!starts && lines.some(ls => ls.filter(l => valLine(l.text)).length >= 2)) ambiguous++;
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
  if (H.length < 3 && (H.length < 2 || V.length < 2)) return { tables: [], used: new Set() };
  const Hm = mergeLines(H, "y", "x1", "x2"), Vm = mergeLines(V, "x", "y1", "y2");
  const out = []; const used = new Set();
  const lattice = findTables(Hm, Vm);
  // 세로선이 두 개뿐인 묶음(강조 열 배경 사각형 등)은 표가 아니므로 밑줄형 표를 막지 않는다
  const lboxes = lattice.filter(g => cluster(g.V.map(v => v.x)).length >= 3).map(g => ({ x1: Math.min(...g.H.map(h => h.x1)), x2: Math.max(...g.H.map(h => h.x2)), y1: Math.min(...g.V.map(v => v.y1)), y2: Math.max(...g.V.map(v => v.y2)) }));
  for (let g of lattice.concat(findUnderlineTables(Hm, lboxes))) {
    // 밑줄형 표의 왼쪽에 밑줄 없는 항목명 열이 있으면(도요타 영문 결산 보충표) 그 글 시작점까지 표를 넓힌다 — 값만 표로 나가고
    // 항목명이 글로 떨어지면 행 짝이 끊긴다
    if (g.ul) {
      const L = Math.min(...g.V.map(v => v.x)), top = Math.max(...g.H.map(h => h.y)), bot = Math.min(...g.H.map(h => h.y));
      const left = items.filter(it => { const cy = it.y + it.fs * 0.3; return cy > bot && cy < top && it.x + it.w <= L + 1 && it.x >= L - 320; });
      const rowsN = g.H.length - 1;
      // 첫 열에 이미 글(항목명)이 있으면 넓히지 않는다(옆 단 목차까지 끌어들이지 않게 — BMW 14쪽)
      const xs0 = g.V.map(v => v.x).sort((p, q) => p - q);
      const first = items.filter(it => { const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3; return cy > bot && cy < top && cx >= xs0[0] && cx <= xs0[1]; });
      const wordy = first.filter(it => !it.s.trim().split(/\s+/).every(t => NUMV.test(t) || /^[－—–-]$/.test(t))).length;
      if (left.length && wordy < first.length * 0.5 && new Set(left.map(it => Math.round(it.y))).size >= Math.max(2, rowsN * 0.4)) {
        const nx = Math.min(...left.map(it => it.x)) - 1;
        g = { ul: true, H: g.H.map(h => ({ x1: nx, x2: h.x2, y: h.y })), V: [{ x: nx, y1: bot, y2: top }].concat(g.V) };
      }
    }
    let grid = buildGrid(g);
    // 점선을 넣었더니 병합 칸이 ㄱ자가 되면(안내 상자 안의 점선 구분 등) 점선을 빼고 다시 짠다
    if (grid && grid.irregular && (g.H.some(h => h.dash) || g.V.some(v => v.dash))) {
      const g3 = { H: g.H.filter(h => !h.dash), V: g.V.filter(v => !v.dash) };
      const grid3 = g3.H.length >= 2 && g3.V.length >= 2 ? buildGrid(g3) : null;
      if (grid3 && !grid3.irregular) { grid = grid3; g.H = g3.H; g.V = g3.V; }
    }
    if (!grid) continue;
    let bb = Object.assign({}, grid.bbox);
    if (bb.x2 - bb.x1 < 30 || bb.y2 - bb.y1 < 10) continue;
    // 가로선이 세로선 범위보다 넓게 뻗어 있으면 테두리가 일부 열에만 있는 표다(지멘스 실적표: 항목 열에 세로선 없음).
    // 가로선 끝에 보이지 않는 세로 경계를 더해 항목 열을 만든다(2026-11-07). 더한 열 안에 글과 떨어진 숫자가 있으면(값 열이
    // 숨어 있음) 아래 점검에서 '복원 실패'로 돌린다.
    const hx1 = Math.min(...g.H.map(h => h.x1)), hx2 = Math.max(...g.H.map(h => h.x2));
    const partial = hx1 < bb.x1 - 5 || hx2 > bb.x2 + 5;
    let synth = [];
    if (partial) {
      const g2 = { H: g.H, V: g.V.slice() };
      if (hx1 < bb.x1 - 5) { g2.V.push({ x: hx1, y1: bb.y1, y2: bb.y2 }); synth.push(hx1); }
      if (hx2 > bb.x2 + 5) { g2.V.push({ x: hx2, y1: bb.y1, y2: bb.y2 }); synth.push(hx2); }
      const grid2 = buildGrid(g2);
      if (grid2) { grid = grid2; bb = Object.assign({}, grid2.bbox); }
      else { bb.x1 = Math.min(bb.x1, hx1); bb.x2 = Math.max(bb.x2, hx2); synth = null; }
    }
    // 표 안 글자 조각
    const inside = [];
    items.forEach((it, i) => {
      const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3;
      if (cx >= bb.x1 - 1 && cx <= bb.x2 + 1 && cy >= bb.y1 - 1 && cy <= bb.y2 + 1) inside.push(i);
    });
    if (!inside.length) continue;
    let onBorder = 0, overflow = 0; const mineIds = [];
    for (const i of inside) {
      const it = items[i]; const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3;
      const cell = grid.cells.find(c => cx >= c.x1 && cx <= c.x2 && cy >= c.y1 && cy <= c.y2) || grid.cells.find(c => cx >= c.x1 - 1.5 && cx <= c.x2 + 1.5 && cy >= c.y1 - 1.5 && cy <= c.y2 + 1.5);
      if (!cell) { onBorder++; continue; }
      if (it.x < cell.x1 - it.fs * 0.8 || it.x + it.w > cell.x2 + it.fs * 0.8) overflow++;
      cell.items.push(it); used.add(i); mineIds.push(i);
    }
    // 세로 병합 칸(항목 열에만 가로선이 없는 표 — 도요타 자본변동표)에 여러 항목명이 쌓여 있고 그 줄들이 옆 값 줄과 높이가 맞으면,
    // 그 병합 칸이 걸친 행 묶음을 줄 높이마다 한 행으로 다시 짠다(값이 없는 소제목 줄은 빈 값 행이 된다).
    // 세로쓰기("1/일/차")처럼 한 글자 줄은 건드리지 않는다.
    for (const c of grid.cells.slice().sort((p, q) => q.row - p.row)) {
      if (c.rowSpan < 2 || c.colSpan !== 1 || !c.items.length || !grid.cells.includes(c)) continue;
      const ls = cellLines(c.items);
      if (ls.length < 3 || ls.filter(l => l.text.replace(/\s/g, "").length >= 2).length < ls.length * 0.8) continue;
      const r0 = c.row, r1 = c.row + c.rowSpan; // [r0, r1)
      const block = grid.cells.filter(o => o.row >= r0 && o.row < r1);
      if (block.some(o => o.row + o.rowSpan > r1)) continue;
      const others = block.filter(o => o !== c).flatMap(o => cellLines(o.items));
      const near = l => others.some(o => Math.abs(o.y - l.y) <= Math.max(2, l.fs * 0.5));
      const aligned = ls.filter(near).length;
      const othersAligned = others.filter(o => ls.some(l => Math.abs(o.y - l.y) <= Math.max(2, o.fs * 0.5))).length;
      if (ls.length <= r1 - r0 || aligned < 3 || aligned < ls.length * 0.4 || othersAligned < others.length * 0.6) continue; // 행 수가 줄어드는 재구성은 하지 않는다(연락처 표의 부서명 3줄 × 담당자 4행)
      const starts = ls.map(l => l.y).sort((p, q) => q - p);
      const cols = [...new Set(block.map(o => o.col))];
      const fresh = [];
      for (const o of block) {
        const parts = starts.map((y, j) => ({ row: r0 + j, col: o.col, rowSpan: 1, colSpan: o.colSpan, x1: o.x1, x2: o.x2, y1: o.y1, y2: o.y2, items: [] }));
        for (const it of o.items) { let best = 0, d = Infinity; starts.forEach((y, j) => { const dj = Math.abs(y - it.y); if (dj < d) { d = dj; best = j; } }); parts[best].items.push(it); }
        // 같은 열의 여러 원래 칸이 같은 새 행을 만들면 합친다
        for (const p of parts) { const f = fresh.find(q => q.row === p.row && q.col === p.col); if (f) f.items.push(...p.items); else fresh.push(p); }
      }
      const delta = starts.length - (r1 - r0);
      grid.cells = grid.cells.filter(o => !block.includes(o));
      grid.cells.forEach(o => { if (o.row >= r1) o.row += delta; else if (o.row + o.rowSpan > r0 && o.row < r0) o.rowSpan += delta; });
      grid.cells.push(...fresh);
      grid.R += delta;
      void cols;
    }
    const sp = splitRows(grid);
    // 머리글 띠: 표 맨 위 가로선 바로 위에 표 너비만 한 윗선(지멘스 실적표의 굵은 윗선)이 따로 있고 그 사이에 머리글 줄이 있으면,
    // 글자 조각이 모두 한 열 안에 드는 줄만 머리글 행으로 붙인다(열 경계에 걸친 'Q3' 같은 묶음 머리글 줄은 글로 남긴다).
    // 밑줄형 표: 밑줄 없는 윗줄(밑줄이 일부 행에만 있는 표의 앞 행·열 이름 줄)을 위로 이어 행으로 붙인다.
    // 글자 조각이 모두 한 열 안에 드는 줄만, 줄 간격이 행 높이의 2.5배를 넘거나 열 경계에 걸친 줄('Yen in millions')이 나오면 멈춘다.
    let ulHead = !g.ul;
    if (g.ul) {
      const hs = grid.ys.slice(0, -1).map((y, i) => y - grid.ys[i + 1]).sort((p, q) => p - q);
      const rowH = hs[Math.floor(hs.length / 2)] || 12;
      const top = grid.ys[0];
      const cand = [];
      items.forEach((it, i) => { const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3; if (!used.has(i) && cx >= bb.x1 && cx <= bb.x2 && cy > top && cy < top + rowH * 8) cand.push(i); });
      const lines2 = [];
      for (const i of cand) { const it = items[i]; const L = lines2.find(r => Math.abs(r.y - it.y) <= Math.max(2, it.fs * 0.5)); if (L) L.ids.push(i); else lines2.push({ y: it.y, ids: [i] }); }
      lines2.sort((p, q) => p.y - q.y);
      const added = []; let prevY = top; let seenHead = false;
      for (const ln of lines2) {
        if (ln.y - prevY > rowH * 2.5) break;
        const per = new Map(); let fit = true;
        for (const i of ln.ids) {
          const it = items[i];
          let c = grid.xs.findIndex((x, k) => k < grid.C && it.x >= x - 1 && it.x + it.w <= grid.xs[k + 1] + 1);
          // 두 열에 걸친 글자 묶음 머리글('Financial Services' — 오른쪽 맞춤)은 끝이 든 열에 둔다(숫자는 그러지 않는다)
          if (c < 0 && !NUMV.test(it.s.trim()) && it.x >= grid.xs[1] - 1) c = grid.xs.findIndex((x, k) => k < grid.C && it.x + it.w - 1 >= x && it.x + it.w - 1 <= grid.xs[k + 1] + 1);
          if (c < 0) { fit = false; break; }
          if (!per.has(c)) per.set(c, []); per.get(c).push(it);
        }
        if (!fit) break;
        // 항목 열에만 있는 줄: 길면(문단) 멈추고, 이미 열 이름 줄을 지났으면(표 위 제목·설명) 멈춘다
        const labelOnly = per.size === 1 && per.has(0);
        const txt = ln.ids.map(i => items[i].s).join(" ").trim();
        if (labelOnly && (txt.length > 60 || seenHead)) break;
        if ([...per.keys()].filter(c => c > 0).length >= 2 && [...per.entries()].some(([c, its]) => c > 0 && its.some(it => !NUMV.test(it.s.trim()) && !/^[－—–-]$/.test(it.s.trim()) && !/^[-–—]?\s*[\d,.()%]+$/.test(it.s.trim())))) seenHead = true;
        added.unshift({ per, ids: ln.ids }); prevY = ln.y;
      }
      if (added.length) {
        const k = added.length;
        sp.cells.forEach(c => { c.row += k; });
        added.forEach((h, j) => { for (const [c, its] of h.per) sp.cells.push({ row: j, col: c, rowSpan: 1, colSpan: 1, text: its.sort((a, b) => a.x - b.x).map(t => t.s).join(" ").replace(/\s+/g, " ").trim() }); h.ids.forEach(i => used.add(i)); });
        sp.R += k; bb.y2 = Math.max(bb.y2, ...added.flatMap(h => h.ids.map(i => items[i].y + items[i].fs)));
      }
      // 열 이름 줄(숫자 값이 아닌 글이 값 열의 절반 이상에 있는 행)이 있어야 표로 낸다
      const valueCols = [...new Set(sp.cells.filter(c => c.col > 0 && c.text).map(c => c.col))];
      const byR = new Map(); sp.cells.forEach(c => { if (!byR.has(c.row)) byR.set(c.row, []); byR.get(c.row).push(c); });
      ulHead = [...byR.values()].some(cs => { const named = cs.filter(c => c.col > 0 && c.text && (/^(19|20)\d{2}$/.test(c.text.trim()) || !c.text.split(/\s+/).every(t => NUMV.test(t) || /^[－—–-]$/.test(t)))); return valueCols.length && named.length >= Math.ceil(valueCols.length / 2); });
    }
    const pre = sp.cells.filter(c => c.text);
    if (!sp.ambiguous && !grid.irregular && grid.C >= 3 && new Set(pre.map(c => c.col)).size >= 3 && new Set(pre.map(c => c.row)).size >= 2) {
      const top = grid.ys[0], width = bb.x2 - bb.x1;
      const cap = Hm.filter(h => h.y > top + 4 && h.y < top + 45 && Math.min(h.x2, bb.x2) - Math.max(h.x1, bb.x1) >= width * 0.8).sort((p, q) => p.y - q.y)[0];
      if (cap) {
        const band = [];
        items.forEach((it, i) => { const cx = it.x + it.w / 2, cy = it.y + it.fs * 0.3; if (!used.has(i) && cx >= bb.x1 && cx <= bb.x2 && cy > top && cy < cap.y) band.push(i); });
        const rows = [];
        for (const i of band) { const it = items[i]; const L = rows.find(r => Math.abs(r.y - it.y) <= Math.max(2, it.fs * 0.5)); if (L) L.ids.push(i); else rows.push({ y: it.y, ids: [i] }); }
        rows.sort((p, q) => p.y - q.y); // 표에 가까운(아래) 줄부터
        const head = [];
        for (const r of rows) {
          const per = new Map(); let fit = true;
          for (const i of r.ids) {
            const it = items[i]; const c = grid.xs.findIndex((x, k) => k < grid.C && it.x >= x - 1 && it.x + it.w <= grid.xs[k + 1] + 1);
            if (c < 0) { fit = false; break; }
            if (!per.has(c)) per.set(c, []); per.get(c).push(it);
          }
          if (!fit || per.size < 2) break;
          head.unshift({ per, ids: r.ids });
        }
        if (head.length) {
          const k = head.length;
          sp.cells.forEach(c => { c.row += k; });
          head.forEach((h, j) => { for (const [c, its] of h.per) sp.cells.push({ row: j, col: c, rowSpan: 1, colSpan: 1, text: its.sort((a, b) => a.x - b.x).map(t => t.s).join(" ").replace(/\s+/g, " ").trim() }); h.ids.forEach(i => used.add(i)); });
          sp.R += k; bb.y2 = Math.max(bb.y2, ...head.flatMap(h => h.ids.map(i => items[i].y + items[i].fs * 0.6)));
        }
      }
    }
    const cells = sp.cells;
    const filled = cells.filter(c => c.text);
    const realCols = new Set(filled.map(c => c.col)).size, realRows = new Set(filled.map(c => c.row)).size;
    let ok = true, why = "";
    // 한 칸 안에서 같은 줄 글자 사이가 크게 벌어졌으면 세로선 없는 열이 칸 안에 숨어 있다
    const hiddenCols = grid.cells.some(c => cellLines(c.items).length && (() => {
      const its = c.items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
      for (let k = 1; k < its.length; k++) { const a = its[k - 1], b = its[k]; if (Math.abs(a.y - b.y) <= Math.max(2, b.fs * 0.5) && b.x - (a.x + a.w) > b.fs * 2.2 && NUMV.test(a.s.trim()) && NUMV.test(b.s.trim())) return true; }
      // 글자 조각 하나에 값 둘이 공백으로 붙어 온 경우(삼성 실적표 "0.1↑ 4.2↓", 지멘스 "17.3% 14.9%"): 줄이 숫자 값만 둘 이상이면 숨은 열
      for (const l of cellLines(c.items)) { const tk = l.text.split(/\s+/).filter(Boolean); if (tk.length >= 2 && tk.every(t => NUMV.test(t) && !/^\d+\.$/.test(t))) return true; }
      return false;
    })());
    // 더한 경계 옆 열(항목 열)에 글과 크게 떨어진 숫자가 있으면 그 열에 값 열이 숨어 있다
    const synthCols = synth ? synth.map(x => grid.xs.findIndex(v => Math.abs(v - x) <= TOL * 1.5)).map(i => (i === 0 ? 0 : i - 1)) : [];
    const hiddenInSynth = synth && grid.cells.some(c => (synthCols.includes(c.col)) && (() => {
      const its = c.items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
      for (let k = 1; k < its.length; k++) { const a = its[k - 1], b = its[k]; if (Math.abs(a.y - b.y) <= Math.max(2, b.fs * 0.5) && b.x - (a.x + a.w) > b.fs * 2.2 && NUMV.test(b.s.trim())) return true; }
      return false;
    })());
    if (!ulHead) { ok = false; why = "밑줄만 있는 표에서 열 이름 줄을 찾지 못함"; }
    else if (partial && (!synth || hiddenInSynth)) { ok = false; why = "표 테두리가 일부 열에만 있어 항목명과 값을 같은 칸으로 묶지 못함"; }
    else if (hiddenCols) { ok = false; why = "세로 테두리 없는 열이 칸 안에 섞여 있음"; }
    else if (grid.irregular) { ok = false; why = "병합 칸 모양이 직사각형이 아님"; }
    else if (sp.ambiguous) { ok = false; why = "가로 테두리 없이 여러 행이 한 칸에 든 것으로 보이나 행을 확실히 나누지 못함"; }
    else if (onBorder > Math.max(1, inside.length * 0.03)) { ok = false; why = `경계선에 걸친 글자 ${onBorder}개`; }
    else if (overflow > Math.max(1, inside.length * 0.03)) { ok = false; why = `칸 밖으로 넘친 글자 ${overflow}개`; }
    const box = realCols <= 1 || realRows <= 1;
    if (box) mineIds.forEach(i => used.delete(i)); // 글상자(강조 배경 사각형 등)는 표가 아니므로 글자를 붙잡지 않는다
    out.push({ bbox: bb, cells, R: sp.R, C: grid.C, ok, why, split: sp.split, box });
  }
  return { tables: out, used };
}

module.exports = { pageTables, cellText, _test: { splitRows, cellLines, collectSegments, mergeLines, findTables, buildGrid, cluster } };
