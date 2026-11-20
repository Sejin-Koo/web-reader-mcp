// 중간 인증서를 빼고 보내는 사이트: 기본 fetch는 UNABLE_TO_VERIFY_LEAF_SIGNATURE로 실패하고,
// lib/aia.js가 인증서의 발급자 주소(AIA)에서 중간 인증서를 받아 검증을 켠 채 읽는지 확인한다.
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), https = require("https"), http = require("http");
const assert = require("assert");
const aia = require("../lib/aia");
const { fetch: undiciFetch } = require("undici");

const d = fs.mkdtempSync(path.join(os.tmpdir(), "aia-"));
const sh = (...a) => execFileSync("openssl", a, { cwd: d, stdio: "pipe" });
(async () => {
  const caPort = 18000 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(path.join(d, "int.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  fs.writeFileSync(path.join(d, "leaf.ext"), `subjectAltName=DNS:localhost\nauthorityInfoAccess=caIssuers;URI:http://127.0.0.1:${caPort}/int.der\n`);
  sh("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-days", "2", "-subj", "/CN=Test Root");
  sh("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "int.key", "-out", "int.csr", "-subj", "/CN=Test Intermediate");
  sh("x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "int.pem", "-days", "2", "-extfile", "int.ext");
  sh("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost");
  sh("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.ext");
  sh("x509", "-in", "int.pem", "-outform", "DER", "-out", "int.der");
  const root = fs.readFileSync(path.join(d, "root.pem"), "utf8");

  const caSrv = http.createServer((q, r) => { r.end(fs.readFileSync(path.join(d, "int.der"))); }).listen(caPort, "127.0.0.1");
  const srv = https.createServer({ key: fs.readFileSync(path.join(d, "leaf.key")), cert: fs.readFileSync(path.join(d, "leaf.pem")) }, (q, r) => r.end("hello")).listen(0, "127.0.0.1");
  await new Promise(r => srv.on("listening", r));
  const port = srv.address().port;
  const url = `https://localhost:${port}/`;
  aia._test.setExtraRoots([root]);
  try {
    // 1) 루트만 믿는 기본 연결은 체인 오류
    let err;
    try { await undiciFetch(url, { dispatcher: new (require("undici").Agent)({ connect: { ca: [root] } }) }); } catch (e) { err = e; }
    assert.ok(err && aia.isChainError(err), `체인 오류여야 함: ${err && err.cause && err.cause.code}`);
    // 2) AIA로 받은 중간 인증서를 붙이면 검증을 켠 채 성공
    const disp = await aia.aiaDispatcher("localhost", port);
    assert.ok(disp, "dispatcher를 만들어야 함");
    const r = await undiciFetch(url, { dispatcher: disp });
    assert.strictEqual(await r.text(), "hello");
    // 3) 다른 사람이 서명한 인증서는 여전히 거부(검증이 켜져 있음)
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "aia2-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "k", "-out", "c", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { cwd: other, stdio: "pipe" });
    const bad = https.createServer({ key: fs.readFileSync(path.join(other, "k")), cert: fs.readFileSync(path.join(other, "c")) }, (q, r) => r.end("x")).listen(0, "127.0.0.1");
    await new Promise(r => bad.on("listening", r));
    let badErr; try { await undiciFetch(`https://localhost:${bad.address().port}/`, { dispatcher: disp }); } catch (e) { badErr = e; }
    assert.ok(badErr, "자체 서명 인증서는 거부해야 함");
    bad.close();
    console.log("aia.smoke ok");
  } finally { srv.close(); caSrv.close(); }
})().catch(e => { console.error(e); process.exit(1); });
