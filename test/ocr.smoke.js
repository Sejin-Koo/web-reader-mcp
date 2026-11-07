// 스캔 PDF 글자 인식 점검: 글자 없는 PDF(그림 한 장)가 스캔으로 판정되고, 글자 인식으로 한국어 본문이 나오는지
// 실행: node --no-experimental-require-module test/ocr.smoke.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const docs = require("../lib/docs");
const ocr = require("../lib/ocr");
(async () => {
  const buf = fs.readFileSync(path.join(__dirname, "fixtures", "scan-ko.pdf"));
  await assert.rejects(() => docs.fileToText(buf), /스캔 이미지로 보임, 전체 1쪽/);
  console.log("ok 1 - 글자 없는 PDF는 스캔으로 판정(쪽 수 포함)");
  const r = await ocr.ocrPdf(buf, { firstPage: 1, langs: ["kor", "eng"] });
  assert.strictEqual(r.total, 1); assert.strictEqual(r.next, null); assert.strictEqual(r.pages.length, 1);
  assert.ok(/보도자료/.test(r.pages[0].text) && /경제협력/.test(r.pages[0].text), r.pages[0].text.slice(0, 200));
  assert.ok(r.pages[0].conf >= 70, `신뢰도 ${r.pages[0].conf}`);
  console.log(`ok 2 - 한국어 글자 인식(신뢰도 ${r.pages[0].conf}, ${r.ms}ms)`);
  await assert.rejects(() => ocr.ocrPdf(buf, { firstPage: 3 }), /범위 밖/);
  console.log("ok 3 - 범위 밖 시작 쪽은 오류");
  console.log("모두 통과");
})().catch(e => { console.error(e); process.exit(1); });
