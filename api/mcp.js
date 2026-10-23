// web-reader-mcp — 웹 검색(web_search)·웹페이지 읽기(fetch_page, HWP·HWPX 포함) MCP 서버.
// 계정 커넥터가 직접 부르고, 업무 에이전트 중계 서버(agent-relay-mcp)도 다른 백엔드처럼 이 서버를 부른다.
// 도구 구현은 lib/web.js(검색·읽기·robots·주소 안전 확인·한도)와 lib/hwp.js(한글 문서 변환)에 있다.
//
// 게이트 (sys-mcp-gatekey 2-2 표준 코드)
//   MCP_GATE_KEYS : 허용 키 목록(쉼표 구분). 비어 있으면 게이트 비활성(모두 통과).
//   MCP_GATE_MODE : "enforce"면 키가 없거나 목록에 없을 때 401 차단.
//
// 사람별 한도의 기준(caller)
//   기본은 게이트키 식별자(plk_<식별자>_…). 중계 서버 키로 들어온 호출은 중계 서버가 보낸
//   X-Relay-Caller 헤더(에이전트 사용자 식별자)를 기준으로 센다 — 중계 서버 시절과 같은 카운터 키.
//   헤더를 믿는 키 식별자는 TRUSTED_RELAY_LABELS(쉼표 구분, 기본 "relay")로 정한다.

const web = require("../lib/web");

const SERVER_INFO = { name: "web-reader-mcp", version: "1.0.0" };
// @modelcontextprotocol/sdk 1.32.1 의 SUPPORTED_PROTOCOL_VERSIONS 와 같은 값으로 맞춘다
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST = SUPPORTED[0];

const GATE_KEYS = (process.env.MCP_GATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();
const RELAY_LABELS = (process.env.TRUSTED_RELAY_LABELS || "relay").split(",").map(s => s.trim()).filter(Boolean);

function keyLabel(k) {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

function callerOf(label, req) {
  if (!RELAY_LABELS.includes(label)) return label;
  const h = String(req.headers["x-relay-caller"] || "").replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 64);
  return h || label;
}

async function callTool(params, caller) {
  const name = params && params.name;
  if (!web.NAMES.includes(name)) {
    return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  const t0 = Date.now();
  try {
    const result = await web.call(name, (params && params.arguments) || {}, caller);
    console.log(`[call] caller=${caller} tool=${name} ms=${Date.now() - t0} ok=${!result.isError}`);
    return { result };
  } catch (e) {
    console.log(`[call] caller=${caller} tool=${name} ms=${Date.now() - t0} fail=${e.message}`);
    return { result: { isError: true, content: [{ type: "text", text: `웹 도구 오류: ${e.message}` }] } };
  }
}

async function handleMessage(m, caller) {
  const isNotification = m && m.id === undefined;
  const reply = (body) => (isNotification ? null : Object.assign({ jsonrpc: "2.0", id: m.id }, body));
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return { jsonrpc: "2.0", id: (m && m.id) ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  switch (m.method) {
    case "initialize": {
      const req = m.params && m.params.protocolVersion;
      return reply({ result: {
        protocolVersion: SUPPORTED.includes(req) ? req : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "웹 검색(web_search)과 웹페이지 본문 읽기(fetch_page) 서버입니다. fetch_page는 한글 문서(HWP·HWPX) 첨부 주소를 받으면 본문과 표를 글로 바꿔 줍니다. robots.txt가 막은 주소는 읽지 않습니다."
      } });
    }
    case "ping":
      return reply({ result: {} });
    case "tools/list":
      return reply({ result: { tools: web.TOOLS } });
    case "tools/call":
      return reply(await callTool(m.params, caller));
    default:
      if (isNotification) return null;
      return reply({ error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === "string" ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body)));
  }
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  let gk = (req.query && req.query.k) || null;
  if (!gk) {
    try { gk = new URL(req.url, "http://localhost").searchParams.get("k"); } catch (e) { gk = null; }
  }
  const allowed = GATE_KEYS.length === 0 || (!!gk && GATE_KEYS.includes(gk));
  const label = keyLabel(gk);
  console.log(`[gate] mode=${GATE_MODE} method=${req.method} caller=${label} allowed=${allowed}`);
  if (!allowed && GATE_MODE === "enforce") {
    sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } });
    return;
  }
  const caller = callerOf(label, req);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    sendJson(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed. Use POST." } });
    return;
  }

  const pv = req.headers["mcp-protocol-version"];
  if (pv && !SUPPORTED.includes(String(pv))) {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: {
      code: -32600, message: `Bad Request: Unsupported protocol version (supported versions: ${SUPPORTED.join(", ")})`
    } });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const msgs = Array.isArray(body) ? body : [body];
  const hasRequest = msgs.some(m => m && m.id !== undefined);
  if (!hasRequest) {
    await Promise.all(msgs.map(m => handleMessage(m, caller)));
    res.statusCode = 202; res.end(); return;
  }

  // 대체 경로(Nimble·Tavily) 읽기는 30초를 넘을 수 있다. SSE를 받는 클라이언트에는 10초마다
  // keepalive 주석을 보내 중간 프록시가 연결을 끊지 않게 한다(중계 서버와 같은 방식).
  const accept = String(req.headers["accept"] || "");
  if (/text\/event-stream/i.test(accept)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();
    const ka = setInterval(() => { try { res.write(": keepalive\n\n"); } catch (e) {} }, 10000);
    try {
      const outs = (await Promise.all(msgs.map(m => handleMessage(m, caller)))).filter(Boolean);
      const payload = Array.isArray(body) ? outs : outs[0];
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } finally {
      clearInterval(ka);
      res.end();
    }
    return;
  }

  const outs = (await Promise.all(msgs.map(m => handleMessage(m, caller)))).filter(Boolean);
  sendJson(res, 200, Array.isArray(body) ? outs : outs[0]);
};
