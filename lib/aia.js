// 중간 인증서를 빼고 보내는 사이트(서버 설정 누락)를 브라우저처럼 읽기 — AIA(Authority Information Access) 따라가기.
// 2026-11-17·20 실측: kmcca.or.kr 첨부가 매번 'fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)'. 브라우저는 인증서에 적힌
// 발급자 주소(CA Issuers)에서 중간 인증서를 받아 검증을 이어 가지만 Node는 하지 않는다.
// 이 모듈은 (1) 사이트 인증서를 읽기만 하는 연결로 발급자 주소를 얻고(데이터는 보내지 않음) (2) 중간 인증서를 받아
// (3) 기본 루트 인증서 + 받은 중간 인증서로 '검증을 켠 채' 다시 연결하는 dispatcher를 만든다. 검증을 끄지 않는다.
const tls = require("tls");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { Agent } = require("undici");

const cache = new Map(); // host:port -> { agent, at } | { fail, at }
const KEEP_MS = 6 * 3600 * 1000;
let EXTRA_ROOTS = []; // 시험용(test/aia.smoke.js)만 채운다

function peerCert(host, port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = s.getPeerCertificate(true); s.end(); resolve(c);
    });
    s.on("timeout", () => { s.destroy(); reject(new Error("인증서 읽기 시간 초과")); });
    s.on("error", reject);
  });
}
function issuerUrls(infoAccess) {
  // Node: getPeerCertificate().infoAccess = { 'CA Issuers - URI': [...] } / X509Certificate.infoAccess = 문자열
  if (!infoAccess) return [];
  if (typeof infoAccess === "string") return [...infoAccess.matchAll(/CA Issuers - URI:(\S+)/g)].map(m => m[1]);
  return (infoAccess["CA Issuers - URI"] || []).slice();
}
function download(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { timeout: 8000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let n = 0;
      res.on("data", c => { n += c.length; if (n > 64 * 1024) { req.destroy(); reject(new Error("too large")); } else chunks.push(c); });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}
function toPem(buf) {
  const s = buf.toString("latin1");
  if (s.includes("-----BEGIN CERTIFICATE-----")) return s;
  const b64 = buf.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// 중간 인증서를 붙인 dispatcher. 못 만들면 null(호출부는 원래 실패를 그대로 돌려준다).
async function aiaDispatcher(hostname, port = 443) {
  const key = `${hostname}:${port}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.agent || null;
  try {
    const leaf = await peerCert(hostname, port);
    const pems = [];
    let urls = issuerUrls(leaf && leaf.infoAccess);
    for (let depth = 0; depth < 3 && urls.length; depth++) {
      const der = await download(urls[0]);
      const pem = toPem(der);
      const x = new crypto.X509Certificate(pem); // 인증서가 아니면 여기서 실패
      pems.push(pem);
      if (x.issuer === x.subject) break;               // 루트까지 왔음
      urls = issuerUrls(x.infoAccess);
    }
    if (!pems.length) throw new Error("발급자 주소(AIA) 없음");
    const agent = new Agent({ connect: { ca: [...tls.rootCertificates, ...EXTRA_ROOTS, ...pems] } });
    cache.set(key, { agent, at: Date.now() });
    return agent;
  } catch (e) {
    console.log(`[aia] ${key} 중간 인증서 받기 실패: ${e.message}`);
    cache.set(key, { fail: true, at: Date.now() });
    return null;
  }
}
const CHAIN_CODES = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT"]);
function isChainError(e) { return !!(e && e.cause && CHAIN_CODES.has(e.cause.code)); }

module.exports = { aiaDispatcher, isChainError, _test: { issuerUrls, toPem, setExtraRoots: r => { EXTRA_ROOTS = r; cache.clear(); } } };
