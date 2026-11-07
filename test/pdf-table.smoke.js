// PDF 표 칸 복원 스모크테스트(2026-11-07) — 손으로 만든 작은 PDF로 테두리 표·테두리 없는 하위 행·일부 테두리 표·쪽 그림을 확인.
// 실행: node test/pdf-table.smoke.js
const docs = require("../lib/docs");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };

// 아주 작은 PDF 만들기(Helvetica, 선·사각형·글자). 좌표는 PDF 단위(왼쪽 아래 원점)
function makePdf(pages) {
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];
  const pagesId = objs.length + 1 + pages.length * 2; // 나중에 만들 Pages 번호
  for (const ops of pages) {
    const stream = ops.join("\n");
    const c = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  const pid = add(`<< /Type /Pages /Kids [${pageIds.map(i => i + " 0 R").join(" ")}] /Count ${pageIds.length} >>`);
  if (pid !== pagesId) throw new Error("pages id mismatch");
  const cat = add(`<< /Type /Catalog /Pages ${pid} 0 R >>`);
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const T = (x, y, s) => `BT /F1 10 Tf ${x} ${y} Td (${s}) Tj ET`;
const L = (x1, y1, x2, y2) => `${x1} ${y1} m ${x2} ${y2} l S`;
// 격자: xs·ys 위의 모든 선(빼고 싶은 칸 경계는 skip으로)
function grid(xs, ys, skipH) {
  const o = ["0.5 w"];
  ys.forEach((y, i) => { if (!(skipH || []).includes(i)) o.push(L(xs[0], y, xs[xs.length - 1], y)); });
  xs.forEach(x => o.push(L(x, ys[0], x, ys[ys.length - 1])));
  return o;
}

(async () => {
  // 1) 테두리 표 + 두 줄 칸(자동 줄넘김) — 한 행으로 묶여야
  const p1 = grid([50, 150, 300, 450], [700, 680, 640, 620])
    .concat([T(55, 686, "Item"), T(155, 686, "2025"), T(305, 686, "2026"),
      T(55, 660, "Revenue"), T(55, 648, "(total)"), T(155, 654, "1,234"), T(305, 654, "1,500"),
      T(55, 626, "Profit"), T(155, 626, "200"), T(305, 626, "310")]);
  let r = await docs.fileToText(makePdf([p1]));
  ok(/\| Item \| 2025 \| 2026 \|/.test(r.text) && /\| Revenue \(total\) \| 1,234 \| 1,500 \|/.test(r.text) && /\| Profit \| 200 \| 310 \|/.test(r.text) && r.tableCheck.ok === 1, "테두리 표 → 마크다운 표(두 줄 칸은 한 칸으로)");

  // 2) 가로 테두리 없이 여러 행이 한 칸 줄에 든 일정표 — 같은 모양 시각으로 하위 행 분리
  const p2 = grid([50, 150, 400], [700, 680, 600], [])
    .concat([T(55, 686, "Time"), T(155, 686, "Program"),
      T(55, 660, "10:00~10:10"), T(155, 660, "Opening"),
      T(55, 640, "10:10~10:30"), T(155, 640, "Keynote"),
      T(55, 620, "10:30~11:00"), T(155, 620, "Panel")]);
  r = await docs.fileToText(makePdf([p2]));
  ok(/\| 10:00~10:10 \| Opening \|/.test(r.text) && /\| 10:10~10:30 \| Keynote \|/.test(r.text) && /\| 10:30~11:00 \| Panel \|/.test(r.text), "테두리 없는 하위 행(같은 모양 시각) 분리");

  // 3) 일부 열에만 세로선(항목 열은 선 없음) — 표로 내지 않고 [표 확인 필요]
  const p3 = ["0.5 w", L(50, 700, 450, 700), L(50, 680, 450, 680), L(50, 660, 450, 660), L(50, 640, 450, 640), L(300, 700, 300, 640), L(380, 700, 380, 640), L(450, 700, 450, 640)]
    .concat([T(55, 686, "Orders"), T(200, 686, "27,902"), T(250, 686, "24,719"), T(310, 686, "13%"), T(390, 686, "14%"),
      T(55, 666, "Revenue"), T(200, 666, "20,794"), T(250, 666, "19,377"), T(310, 666, "7%"), T(390, 666, "8%"),
      T(55, 646, "Profit"), T(200, 646, "3,524"), T(250, 646, "2,820"), T(310, 646, "25%")]);
  r = await docs.fileToText(makePdf([p3])); 
  ok(r.tableCheck.ok === 0 && r.tableCheck.failed.length >= 1 && r.text.includes("[표 확인 필요") && /Orders.*27,902/.test(r.text), "일부 열에만 테두리 → 표 확인 필요로 표시(항목명과 값은 같은 줄에 남김)");

  // 4) 테두리 없는 숫자 표 — [표 확인 필요]
  const p4 = [T(50, 700, "Sales"), T(250, 700, "100.5"), T(350, 700, "120.3"),
    T(50, 685, "Cost"), T(250, 685, "60.1"), T(350, 685, "70.2"),
    T(50, 670, "Margin"), T(250, 670, "40.4"), T(350, 670, "50.1")];
  r = await docs.fileToText(makePdf([p4]));
  ok(r.tableCheck.borderless.length >= 1 && r.text.includes("테두리 없는 표"), "테두리 없는 숫자 표 → 표 확인 필요로 표시");

  // 5) 점선 칸 구분(점 조각 수백 개) — 점선을 선으로 이어 행을 나눈다
  const dots = (x1, x2, y) => { const o = []; for (let x = x1; x < x2; x += 1.2) o.push(`${x.toFixed(2)} ${y} m ${(x + 0.5).toFixed(2)} ${y} l S`); return o; };
  const p5 = ["0.5 w", L(50, 700, 400, 700), L(50, 680, 400, 680), L(50, 620, 400, 620), L(50, 700, 50, 620), L(150, 700, 150, 620), L(400, 700, 400, 620)]
    .concat(dots(50, 400, 660), dots(50, 400, 640))
    .concat([T(55, 686, "Time"), T(155, 686, "Program"), T(55, 666, "Opening"), T(155, 666, "Live"), T(55, 646, "Group talk"), T(155, 646, "Closed"), T(55, 626, "Closing"), T(155, 626, "Live")]);
  r = await docs.fileToText(makePdf([p5]));
  ok(r.tableCheck.ok === 1 && /\| Group talk \| Closed \|/.test(r.text) && /\| Closing \| Live \|/.test(r.text), "점선 칸 구분을 선으로 이어 행 분리");

  // 6) 항목 열에 세로선이 없는 표(가로선만 넓음) + 윗선과 머리글 줄 — 항목 열을 만들어 복원하고 머리글을 붙인다
  const p6 = ["0.5 w", L(50, 720, 450, 720), L(50, 690, 450, 690), L(50, 670, 450, 670), L(50, 650, 450, 650), L(250, 700, 250, 650), L(350, 700, 350, 650)]
    .concat([T(260, 695, "FY2026"), T(360, 695, "FY2025"), T(55, 676, "Orders"), T(260, 676, "27,902"), T(360, 676, "24,719"), T(55, 656, "Revenue"), T(260, 656, "20,794"), T(360, 656, "19,377")]);
  r = await docs.fileToText(makePdf([p6]));
  ok(r.tableCheck.ok === 1 && /\|  \| FY2026 \| FY2025 \|/.test(r.text) && /\| Orders \| 27,902 \| 24,719 \|/.test(r.text), "항목 열 세로선 없는 표 복원 + 머리글 행");

  // 7) 한 글자 조각에 값 둘이 붙은 칸("17.3% 14.9%") — 숨은 열로 보고 확인 필요
  const p7 = grid([50, 200, 400], [700, 680, 660, 640]).concat([T(55, 686, "Item"), T(205, 686, "Value"), T(55, 666, "Margin"), T(205, 666, "17.3%  14.9%"), T(55, 646, "Orders"), T(205, 646, "27,902  24,719")]);
  r = await docs.fileToText(makePdf([p7]));
  ok(r.tableCheck.ok === 0 && r.tableCheck.failed.length === 1, "한 칸에 값 둘이 붙은 표는 확인 필요");

  // 7-1) 값이 거의 없는 글상자(칸 모양 이상) — 확인 필요 없이 일반 글
  const p71 = ["0.5 w", L(50, 700, 400, 700), L(50, 640, 400, 640), L(50, 700, 50, 640), L(400, 700, 400, 640), L(200, 700, 200, 670), L(50, 670, 200, 670)]
    .concat([T(55, 686, "Notice"), T(205, 686, "Event opens in May"), T(55, 650, "Contact the office for details")]);
  r = await docs.fileToText(makePdf([p71]));
  ok(r.tableCheck.failed.length === 0 && !r.text.includes("[표 확인 필요") && /Contact the office/.test(r.text), "값 없는 글상자는 확인 필요 없이 일반 글");

  // 8) 밑줄형 표(칸마다 밑줄만, 세로선 없음) — 밑줄 틈을 열 경계로
  const ul = (y) => [L(50, y, 150, y), L(155, y, 250, y), L(255, y, 350, y)];
  const p8 = ["0.5 w"].concat(ul(690), ul(675), ul(660), ul(645))
    .concat([T(55, 694, "Item"), T(200, 694, "2026"), T(300, 694, "2025"), T(55, 679, "Deliveries"), T(200, 679, "551,075"), T(300, 679, "588,140"),
      T(55, 664, "EBIT margin"), T(200, 664, "3.4"), T(300, 664, "5.2"), T(55, 649, "Free cash flow"), T(200, 649, "-566"), T(300, 649, "343")]);
  r = await docs.fileToText(makePdf([p8]));
  ok(r.tableCheck.ok === 1 && /\| Item \| 2026 \| 2025 \|/.test(r.text) && /\| Free cash flow \| -566 \| 343 \|/.test(r.text), "밑줄형 표 복원(열 이름 줄 포함)");

  // 9) 쪽 그림
  const img = await docs.renderPdfPages(makePdf([p1, p4]), [2, 9]);
  ok(img.total === 2 && img.images[0].png && img.images[0].png.subarray(1, 4).toString() === "PNG" && img.images[1].error, "pdf_pages: 쪽 그림(PNG)과 범위 밖 쪽 안내");

  console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
