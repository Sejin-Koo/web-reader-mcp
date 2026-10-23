# web-reader-mcp

웹 검색(`web_search`)과 웹페이지 본문 읽기(`fetch_page`) MCP 서버.

- `fetch_page`: 직접 접속 → Nimble → Tavily 순으로 읽는다. HWP·HWPX 첨부는 직접 받아 본문과 표(셀·병합을 살린 마크다운 표)로 바꾼다(`lib/hwp.js`). robots.txt가 막은 주소는 어떤 경로로도 읽지 않는다.
- `web_search`: Tavily → Nimble(lite).
- 계정 커넥터가 직접 부르고, 업무 에이전트 중계 서버(`agent-relay-mcp`)도 백엔드로 부른다. 중계 서버를 내려도 이 서버는 독립적으로 동작한다.

## 환경변수
| 이름 | 용도 |
|---|---|
| `MCP_GATE_KEYS`, `MCP_GATE_MODE` | 접근 게이트(sys-mcp-gatekey) |
| `TRUSTED_RELAY_LABELS` | `X-Relay-Caller` 헤더를 믿는 게이트키 식별자(기본 `relay`) |
| `TAVILY_API_KEY`, `NIMBLE_API_KEY` | 대체 읽기·검색 |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | 사람별 하루 한도·Nimble 월 한도 카운터(Upstash Redis) |
| `WEB_SEARCH_DAILY`, `WEB_PAID_FETCH_DAILY`, `WEB_FETCH_DAILY`, `NIMBLE_MONTHLY_MAX` | 한도 값(기본 60·40·400·1000) |
