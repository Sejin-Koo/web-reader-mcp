// 옛 한글 인코딩(EUC-KR·CP949) 페이지의 링크 주소 맞추기(2026-11-18).
// 브라우저는 주소의 질의(? 뒤) 부분을 그 페이지의 문자 인코딩으로 퍼센트 인코딩한다(URL 표준). new URL()은 늘 UTF-8로
// 바꾸므로, EUC-KR 게시판의 첨부 주소(href에 한글 파일 이름이 그대로 든 것)를 UTF-8로 보내면 서버가 파일을 찾지 못하고
// 엉뚱한 응답(실측: concm.net 자료실 — content-type 'doesn/matter', 글로 못 읽는 파일)을 준다.
// Node에는 EUC-KR 인코더가 없어 TextDecoder로 역표를 한 번 만들어 쓴다.
let table = null;
function eucKrTable() {
  if (table) return table;
  table = new Map();
  const dec = new TextDecoder("euc-kr");
  for (let a = 0x81; a <= 0xfe; a++) {
    for (let b = 0x41; b <= 0xfe; b++) {
      const ch = dec.decode(Uint8Array.of(a, b));
      if (ch.length === 1 && ch !== "�" && !table.has(ch)) table.set(ch, [a, b]);
    }
  }
  return table;
}
function isLegacyKr(cs) { return /^(euc-?kr|cp949|ks_c_5601-1987|ksc5601|x-windows-949|windows-949)$/i.test(String(cs || "").trim()); }
const pct = n => "%" + n.toString(16).toUpperCase().padStart(2, "0");
// 글자 하나 → EUC-KR 퍼센트 인코딩(없는 글자는 UTF-8)
function encChar(ch) {
  const t = eucKrTable().get(ch);
  return t ? t.map(pct).join("") : encodeURIComponent(ch);
}
// href(상대 주소 가능)의 질의 부분 비ASCII 글자를 페이지 인코딩으로 바꾼다. 경로는 브라우저처럼 UTF-8 그대로 둔다
function encodeQueryLegacy(raw, cs) {
  const s = String(raw || "");
  if (!isLegacyKr(cs) || !/[^\x00-\x7f]/.test(s)) return s;
  const q = s.indexOf("?"); if (q < 0) return s;
  const h = s.indexOf("#", q);
  const query = h < 0 ? s.slice(q) : s.slice(q, h);
  return s.slice(0, q) + query.replace(/[^\x00-\x7f]/gu, encChar) + (h < 0 ? "" : s.slice(h));
}
// UTF-8로 퍼센트 인코딩된 질의를 EUC-KR로 다시 쓴 주소(바꿀 한글이 없으면 "")
function utf8QueryToLegacy(href) {
  let u; try { u = new URL(href); } catch (e) { return ""; }
  if (!u.search || !/%[89A-F][0-9A-F]/i.test(u.search)) return "";
  let changed = false;
  const search = u.search.replace(/(?:%[0-9A-F]{2})+/gi, run => {
    let txt; try { txt = decodeURIComponent(run); } catch (e) { return run; }
    if (!/[가-힣ㄱ-ㆎ]/.test(txt)) return run;
    const out = [...txt].map(ch => ch.charCodeAt(0) < 0x80 ? encodeURIComponent(ch) : encChar(ch)).join("");
    if (out !== run) changed = true;
    return out;
  });
  if (!changed) return "";
  return u.origin + u.pathname + search + u.hash;
}
module.exports = { isLegacyKr, encodeQueryLegacy, utf8QueryToLegacy };
