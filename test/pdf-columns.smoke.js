// PDF 두 단 조판 스모크테스트(2026-11-16) — 왼쪽 단을 다 읽은 뒤 오른쪽 단을 읽는지, 한 단 문서·숫자 표는 그대로인지.
// 실행: node test/pdf-columns.smoke.js
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
const read = async (ops) => (await docs._test.pdfToText(makePdf([ops]))).text;
const before = (t, a, b) => t.indexOf(a) >= 0 && t.indexOf(b) >= 0 && t.indexOf(a) < t.indexOf(b);

(async () => {
  // 1) 제목(가로지름) + 두 단 본문(같은 높이에 줄이 나란히) + 가운데 가로지르는 소제목 + 다시 두 단
  const ops = [T(150, 790, "TITLE OF THE ARTICLE SPANNING BOTH COLUMNS OF THE PAGE")];
  for (let i = 0; i < 12; i++) { const y = 750 - i * 14; ops.push(T(50, y, `Left column sentence number L${i} goes here ok`)); ops.push(T(310, y, `Right column sentence number R${i} goes here ok`)); }
  ops.push(T(150, 560, "MIDDLE HEADING THAT RUNS ACROSS THE FULL PAGE WIDTH NOW"));
  for (let i = 0; i < 8; i++) { const y = 530 - i * 14; ops.push(T(50, y, `Lower left column text line P${i} continues`)); ops.push(T(310, y, `Lower right column text line Q${i} continues`)); }
  const t1 = await read(ops);
  ok(before(t1, "TITLE", "L0") && before(t1, "L11", "R0"), "제목 → 왼쪽 단 전부 → 오른쪽 단");
  ok(before(t1, "R11", "MIDDLE HEADING") && before(t1, "MIDDLE HEADING", "P0"), "가로지르는 소제목은 위 구간 뒤, 아래 구간 앞");
  ok(before(t1, "P7", "Q0"), "아래 구간도 왼쪽 단 → 오른쪽 단");
  ok(!/L0 goes here ok Right column/.test(t1), "같은 높이의 두 단 문장을 한 줄로 잇지 않음");

  // 2) 한 단 문서: 줄이 쪽 가운데를 가로지름 — 순서 그대로
  const ops2 = [];
  for (let i = 0; i < 20; i++) ops2.push(T(50, 780 - i * 14, `Single column paragraph line S${i} that is long enough to cross the middle of the page`));
  const t2 = await read(ops2);
  ok(before(t2, "S0", "S1") && before(t2, "S18", "S19"), "한 단 문서는 위에서 아래 순서 그대로");

  // 3) 테두리 없는 숫자 표: 왼쪽 항목·오른쪽 숫자 — 두 단으로 보지 않음(항목과 값이 같은 줄에 남아야)
  const ops3 = [T(50, 790, "Financial summary of the company for the fiscal year")];
  for (let i = 0; i < 12; i++) { const y = 760 - i * 14; ops3.push(T(50, y, `Item${i} revenue line`)); ops3.push(T(400, y, `${(i + 1) * 1234}`)); ops3.push(T(480, y, `${(i + 2) * 987}`)); }
  const t3 = await read(ops3);
  ok(/Item0 revenue line[^\n]*1234/.test(t3), "숫자 표는 항목과 값이 같은 줄에 남음(두 단 아님)");

  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
