// 옛 한글 인코딩(EUC-KR) 페이지의 첨부 주소 스모크테스트(2026-11-18) — concm.net 자료실처럼 href에 한글 파일 이름이 그대로 든 게시판.
// 실행: node test/legacy-charset.smoke.js
const html = require("../lib/html");
const charset = require("../lib/charset");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
const page = body => `<html><head><title>t</title></head><body><main>${"<p>본문 문장입니다. 첨부 파일을 확인하세요.</p>".repeat(20)}${body}</main></body></html>`;
const base = "http://concm.net/ttboard/ttboard.cgi?act=view&code=1768&bname=PDS2";
const EUC = "http://concm.net/ttboard/ttboard.cgi?bname=PDS2&act=file_download&filename=%C0%E7%B0%B3%B9%DF%20%C0%E7%B0%C7%C3%E0%BB%E7%BE%F7%20%BD%C3%C7%E0%C0%FD%C2%F7%B5%B5.pdf";
const UTF = "http://concm.net/ttboard/ttboard.cgi?bname=PDS2&act=file_download&filename=%EC%9E%AC%EA%B0%9C%EB%B0%9C%20%EC%9E%AC%EA%B1%B4%EC%B6%95%EC%82%AC%EC%97%85%20%EC%8B%9C%ED%96%89%EC%A0%88%EC%B0%A8%EB%8F%84.pdf";
(async () => {
  const a = `<a href="ttboard.cgi?bname=PDS2&act=file_download&filename=재개발 재건축사업 시행절차도.pdf">재개발 재건축사업 시행절차도.pdf (15408K)</a>`;
  let h = await html.htmlToPage(page(a), base, true, "euc-kr");
  let l = h.links.find(x => /file_download/.test(x.url));
  ok(l && l.url === EUC, `EUC-KR 페이지 링크 질의는 EUC-KR로: ${l && l.url}`);
  h = await html.htmlToPage(page(a), base, true, "utf-8");
  l = h.links.find(x => /file_download/.test(x.url));
  ok(l && l.url === UTF, `UTF-8 페이지는 그대로 UTF-8: ${l && l.url}`);
  h = await html.htmlToPage(page(a), base, true);
  l = h.links.find(x => /file_download/.test(x.url));
  ok(l && l.url === UTF, "인코딩을 모르면 종전과 같음");
  h = await html.htmlToPage(page(`<a href="/자료/안내.pdf?f=안내">안내.pdf</a>`), base, true, "euc-kr");
  l = h.links.find(x => /pdf/.test(x.url));
  ok(l && l.url === "http://concm.net/%EC%9E%90%EB%A3%8C/%EC%95%88%EB%82%B4.pdf?f=%BE%C8%B3%BB", `경로는 UTF-8, 질의만 EUC-KR(브라우저와 같음): ${l && l.url}`);
  ok(charset.utf8QueryToLegacy(UTF) === EUC, "UTF-8 질의 주소 → EUC-KR 주소(다시 받기용)");
  ok(charset.utf8QueryToLegacy("https://example.com/a?q=abc") === "", "한글 없는 주소는 바꾸지 않음");
  ok(charset.utf8QueryToLegacy("https://example.com/a?q=%E2%80%93") === "", "한글이 아닌 비ASCII는 바꾸지 않음");
  ok(charset.utf8QueryToLegacy(EUC) === "", "이미 EUC-KR이면 바꾸지 않음");
  console.log(`\n${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0);
})();
