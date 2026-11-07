// 스캔 PDF 글자 인식(OCR) — 글자가 없는 PDF를 쪽 그림으로 그린 뒤 tesseract.js(WASM)로 글자를 읽는다(2026-11-07).
//
// 왜: 업무 에이전트는 그림을 볼 수 없어 스캔 PDF(공문·사유서·결정문 스캔본)를 읽을 길이 없었다. 계정 채팅은 쪽 그림(#page=N)으로
//   읽을 수 있지만, 에이전트에는 글이 필요하다. 대체 경로(Tavily)는 사이트에 따라 파일을 가져오지 못했다(미국 국립기록원 실측).
// 한계: 글자 인식은 숫자·고유명사를 틀리게 읽을 수 있고 표의 칸은 복원하지 않는다. 결과 머리에 그 사실과 확인 방법을 붙인다.
// 언어 자료: assets/tessdata의 kor·eng·jpn(tessdata best_int, 압축 상태 약 6.5MB). 일본 사이트(.jp)는 jpn+eng, 국내(.kr)는 kor+eng, 그 밖은 eng+kor.
const path = require("path");

const TESSDATA = path.join(__dirname, "..", "assets", "tessdata");
const MAX_PAGES = 10;
const BUDGET_MS = 50000; // 함수 상한(120초) 안에서 렌더+인식에 쓸 시간
const SCALE = 2.5; // 약 180dpi — 2.0보다 숫자 인식이 낫고 3.5보다 빠름(지멘스 실적표 실측)

async function ocrPdf(buf, { firstPage = 1, langs = ["kor", "eng"] } = {}) {
  const docs = require("./docs");
  const { createWorker } = await import("tesseract.js");
  const t0 = Date.now();
  // 인식 엔진이 내부 오류로 멈추면(파일 누락 등) 응답이 함수 상한까지 매달리므로 단계마다 시간 한도를 건다
  const left = () => Math.max(1000, BUDGET_MS + 15000 - (Date.now() - t0));
  const worker = await within(createWorker(langs, 1, { langPath: TESSDATA, gzip: true, cacheMethod: "none", logger: () => {}, errorHandler: e => console.log(`[ocr] 엔진 오류: ${e && e.message ? e.message : e}`) }), 20000, "인식 엔진 준비 시간 초과");
  const pages = [];
  let total = 0, stoppedBy = "";
  try {
    // 쪽 그림은 3쪽씩 묶어 만든다(문서를 매번 다시 열지 않게)
    outer: for (let p = firstPage; p < firstPage + MAX_PAGES; p += 3) {
      if (Date.now() - t0 > BUDGET_MS) { stoppedBy = "time"; break; }
      const want = [p, p + 1, p + 2].filter(n => n < firstPage + MAX_PAGES && (!total || n <= total));
      if (!want.length) break;
      const r = await docs.renderPdfPages(buf, want, SCALE);
      total = r.total;
      for (const im of r.images) {
        if (!im.png) { if (!pages.length) throw new Error(im.error || "쪽 그림을 만들지 못함"); break outer; }
        if (Date.now() - t0 > BUDGET_MS) { stoppedBy = "time"; break outer; }
        const { data } = await within(worker.recognize(im.png), left(), "쪽 인식 시간 초과");
        pages.push({ page: im.page, text: tidy(data.text || ""), conf: Math.round(data.confidence || 0) });
      }
      if (p + 2 >= total) break;
    }
  } finally {
    try { await worker.terminate(); } catch (e) { /* 무시 */ }
  }
  const last = pages.length ? pages[pages.length - 1].page : firstPage - 1;
  return { total, pages, next: last < total ? last + 1 : null, stoppedBy, ms: Date.now() - t0, langs };
}

function within(p, ms, msg) {
  let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}

// 인식 결과 다듬기: 빈 줄 몰림·줄 끝 공백 정리(글자 자체는 고치지 않는다)
function tidy(t) {
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { ocrPdf, MAX_PAGES };
