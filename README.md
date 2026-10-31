# web-reader-mcp

웹 검색(`web_search`)과 웹페이지 본문 읽기(`fetch_page`) MCP 서버.

- `fetch_page`: 직접 접속 → Nimble → Tavily 순으로 읽는다. HWP·HWPX 첨부는 직접 받아 본문과 표(셀·병합을 살린 마크다운 표)로 바꾼다(`lib/hwp.js`). robots.txt가 막은 주소는 이 서버가 어떤 경로로도 읽지 않는다(Nimble·Tavily 우회 없음). 거부 응답은 호출한 쪽에 "브라우저 도구가 있으면 허락을 구하지 말고 먼저 열어 보라, 없으면 다른 공식 게시처 → 원문 미확인 표기 → 주소 안내" 순서를 알려 준다(계정 man-web-access 경로 B와 같은 순서, 2026-10-29).
- `web_search`: Tavily → Nimble(lite). 결과 제목·요약에 질의 단어가 있는 비율이 0.4 미만이면 이상 결과로 보고 한 번씩 다시 검색한다(한글 질의·country 미지정이면 country=south korea, 그래도 낮으면 Nimble). country 기본값은 바꾸지 않는다(한글로 묻는 해외 주제의 현지 출처가 밀릴 수 있음). 응답의 `relevance`·`notes`에 판정과 재검색 내역이 남는다(2026-10-31).
- 계정 커넥터가 직접 부르고, 업무 에이전트 중계 서버(`agent-relay-mcp`)도 백엔드로 부른다. 중계 서버를 내려도 이 서버는 독립적으로 동작한다.

## 환경변수
| 이름 | 용도 |
|---|---|
| `MCP_GATE_KEYS`, `MCP_GATE_MODE` | 접근 게이트(sys-mcp-gatekey) |
| `TRUSTED_RELAY_LABELS` | `X-Relay-Caller` 헤더를 믿는 게이트키 식별자(기본 `relay`) |
| `TAVILY_API_KEY`, `NIMBLE_API_KEY` | 대체 읽기·검색 |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | 사람별 하루 한도·Nimble 월 한도 카운터(Upstash Redis) |
| `WEB_SEARCH_DAILY`, `WEB_PAID_FETCH_DAILY`, `NIMBLE_MONTHLY_MAX` | 돈이 드는 경로의 한도(기본 사람별 하루 검색 60·대체 읽기 40, 서버 전체 월 Nimble 5000) |
| `WEB_REPEAT_MAX`, `WEB_REPEAT_WINDOW_SEC` | 같은 주소·같은 위치 반복 허용(기본 10분에 5회) — 직접 읽기·HWP 읽기는 횟수로 세지 않고 이것만 본다 |
| `WEB_BURST_PER_MIN`, `WEB_BURST_EXEMPT` | 사람별 1분 호출 상한(기본 60)과 제외 키 식별자(기본 `koo`) |
| `WEB_DAILY_EXEMPT` | 사람별 하루 한도(검색·대체 읽기)를 적용하지 않는 키 식별자(기본 `koo`). 횟수는 그대로 세고, 서버 전체 월 Nimble 한도는 똑같이 적용된다 |
