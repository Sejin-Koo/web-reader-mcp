// 첨부 링크 찾기 스모크테스트(2026-11-16) — 글자 없는 첨부 링크, 누르면 내려받는 단추(onclick·javascript:)의 주소 복원.
// 실행: node test/attach-links.smoke.js
const html = require("../lib/html");
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
const page = body => `<html><head><title>t</title></head><body><main>${"<p>본문 문장입니다. 첨부 파일을 확인하세요.</p>".repeat(20)}${body}</main></body></html>`;
const base = "https://www.example.or.kr/board/view.do?id=1";
(async () => {
  // 1. 대한건설협회형: 내려받기 주소는 글자 없는 링크, 파일 이름은 옆 단추에만
  let h = await html.htmlToPage(page(`<ul><li><a href="/download.do?uuid=ceac-1.hwp" class="viewer"></a><a href="javascript:void(0)" onclick="fnFileView('attach', 'ceac-1.hwp')" class="file">표준 계약서(26년).hwp</a></li></ul>`), base, true);
  let l = h.links.find(x => /download\.do/.test(x.url));
  ok(l && l.text === "표준 계약서(26년).hwp", `글자 없는 첨부 링크에 옆 파일 이름 붙임: ${l && l.text}`);
  ok(!h.notes.some(n => /찾지 못함/.test(n)), "주소 있는 링크가 같은 칸에 있으면 '못 찾음' 안내를 내지 않음");
  // 2. 전자정부 표준 함수
  h = await html.htmlToPage(page(`<a href="javascript:fn_egov_downFile('FILE_000000000012345','0')">보고서.hwp</a>`), base, true);
  l = h.links.find(x => x.button);
  ok(l && l.url === "https://www.example.or.kr/cmm/fms/FileDown.do?atchFileId=FILE_000000000012345&fileSn=0" && l.text === "보고서.hwp", `전자정부 첨부 함수: ${l && l.url}`);
  // 3. 페이지 안 함수 정의에서 주소 틀 찾기
  h = await html.htmlToPage(page(`<script>function fnDown(id, sn){ location.href = "/common/file/download.do?fileId=" + id + "&fileSn=" + encodeURIComponent(sn); }</script><a href="#" onclick="fnDown('AB C', 2); return false;">자료.pdf</a>`), base, true);
  l = h.links.find(x => x.button);
  ok(l && l.url === "https://www.example.or.kr/common/file/download.do?fileId=AB C&fileSn=2".replace(" ", "%20"), `함수 정의의 주소 틀: ${l && l.url}`);
  // 4. 인자에 주소가 그대로 있는 단추
  h = await html.htmlToPage(page(`<button type="button" onclick="fileDownload('/upload/board/2026/a.hwpx')">첨부 a.hwpx</button>`), base, true);
  l = h.links.find(x => x.button);
  ok(l && l.url === "https://www.example.or.kr/upload/board/2026/a.hwpx", `인자 주소: ${l && l.url}`);
  // 5. 변수에 담은 함수(var x = function)와 window.open
  h = await html.htmlToPage(page(`<script>var goFile = function(a){ window.open('/dn.php?f=' + a, '_blank'); };</script><span onclick="goFile('77')">계획.pdf</span>`), base, true);
  l = h.links.find(x => x.button);
  ok(l && l.url === "https://www.example.or.kr/dn.php?f=77", `변수 함수: ${l && l.url}`);
  // 6. 정의를 못 찾으면 싣지 않고 안내만
  h = await html.htmlToPage(page(`<a href="javascript:void(0)" onclick="goFileDown('77')">x.pdf</a>`), base, true);
  ok(!h.links.some(x => x.button) && h.notes.some(n => /1개는 주소를 스크립트가/.test(n)), "정의 없는 단추는 '못 찾음' 안내");
  // 7. 내려받기가 아닌 단추·올리기 단추는 무시
  h = await html.htmlToPage(page(`<a href="javascript:fn_paging(2)">2</a><button onclick="fileUpload('x')">올리기</button>`), base, true);
  ok(!h.links.some(x => x.button) && !h.notes.some(n => /단추/.test(n)), "쪽 넘기기·올리기 단추 무시");
  // 8. 인자에 변수(계산값)가 있으면 추측하지 않음
  h = await html.htmlToPage(page(`<script>function fnDown(id){ location.href='/down.do?id='+id; }</script><a onclick="fnDown(this.dataset.id)">y.pdf</a>`), base, true);
  ok(!h.links.some(x => x.button), "인자가 계산값이면 주소를 만들지 않음");
  // 9. 함수 안에서 모르는 변수를 쓰면 추측하지 않음
  h = await html.htmlToPage(page(`<script>function fnDown(id){ location.href='/down.do?id='+id+'&k='+secret; }</script><a onclick="fnDown('1')">z.pdf</a>`), base, true);
  ok(!h.links.some(x => x.button), "주소 틀에 모르는 변수가 있으면 만들지 않음");
  // 10. links=false면 계산하지 않음
  h = await html.htmlToPage(page(`<a href="javascript:fn_egov_downFile('F1','0')">a.hwp</a>`), base, false);
  ok(h.links.length === 0 && !h.notes.some(n => /단추/.test(n)), "links=false면 링크·안내 없음");
  console.log(`\n${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0);
})();
