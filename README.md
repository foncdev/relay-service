# relay-service

**집 안의 기기에 밖에서 붙게 해주는 중계 서버.**

맥이 공유기 안에 있어도 포트포워딩 없이 접속할 수 있다. **맥이 서버로
나가서 붙고**, 서버가 그 연결로 요청을 되돌려 보내기 때문이다.

```
   agent (집 안)                    relay-service (밖)
        │                                  │
        │ ──── WebSocket 아웃바운드 ────▶     │  ◀──── 브라우저·모바일·안경
        │                                  │
        │ ◀──── 요청을 되돌려 보냄 ─────        │
```

계정 관리와 알림·체크리스트를 직접 갖고 있어서, **agent가 꺼져 있어도**
로그인해서 남은 할 일을 볼 수 있다.

> **경고**
> 인터넷에 열리는 서버다. 토큰을 반드시 설정하고, 특히 터미널 agent를
> 붙일 거라면 [보안](#보안)을 먼저 읽을 것.

---

## 무엇을 하는가

| 역할 | 설명 |
|---|---|
| **중계** | agent가 나가서 붙고, 서버가 그 연결로 요청을 전달 |
| **인증** | 계정 하나(아이디·비밀번호) + 기기별 토큰 |
| **알림·체크리스트** | 서버가 직접 보관. agent가 꺼져도 동작 |
| **관리 UI** | 브라우저에서 쓰는 화면. `web/`에 소스가 있고 `/web`에서 서빙 |

### 관리 UI

`web/`에 React 앱이 들어 있다. Docker 이미지에 함께 빌드돼 있어 받자마자
브라우저로 쓸 수 있다.

| 탭 | 무엇 | 필요한 것 |
|---|---|---|
| 터미널 | 실제 셸 (xterm.js) | terminal agent |
| 할 일 | 체크리스트 | 없음 — 서버가 직접 |
| 알림 | 알림함 | 없음 — 서버가 직접 |
| 세션 | 대화형 세션 | 세션 agent |
| 파일 | 워크스페이스 파일 탐색 | 세션 agent |

**agent가 안 붙어 있으면 그 탭은 "미연결"로 뜬다.** 할 일과 알림은
agent 없이도 쓸 수 있다.

agent는 두 종류를 따로 받는다:

| 접속구 | 용도 | 전달되는 경로 |
|---|---|---|
| `/agent` | 일반 agent | `/sessions` `/workspaces` `/jobs` `/files` `/health` |
| `/terminal-agent` | 터미널 agent | `/terminals` |

**토큰이 서로 다르다.** 터미널 쪽은 셸을 여는 권한이라, 한쪽이 새도 다른
쪽으로 번지지 않게 갈라뒀다.

---

## Docker로 실행 (권장)

```bash
cp .env.example .env    # 토큰을 채운다
docker compose up -d
```

또는 직접:

```bash
docker run -d --name relay-service \
  -p 4100:4100 \
  -v ./data:/app/data \
  --env-file .env \
  foncdev/relay-service:latest
```

그러면 바로 <http://localhost:4100/web> 에서 관리 UI를 쓸 수 있다.
**UI가 이미지에 함께 들어 있다.**

`linux/amd64`와 `linux/arm64`를 지원한다. NAS나 라즈베리파이에서도 돈다.

### 볼륨

| 경로 | 무엇 | 필수 |
|---|---|---|
| `/app/data` | 계정·알림·체크리스트 | **예** — 없으면 컨테이너를 지울 때 함께 사라진다 |
| `/app/glasses` | 안경앱 정적 파일 | 아니오 (별도 저장소) |

관리 UI는 이미지에 있으므로 따로 붙일 필요가 없다. 직접 빌드한 것으로
바꾸려면 `/app/web`에 덮어쓰면 된다.

### 이미지 빌드

```bash
npm run docker:build              # 로컬 빌드
npm run docker:push               # amd64 + arm64 빌드 후 Docker Hub로
```

멀티 아키텍처는 `buildx`가 필요하다. Docker Desktop에는 기본 포함돼 있다.

---

## 소스에서 실행

```bash
npm install
cp .env.example .env
```

`.env`에 토큰을 채운다. 비워두면 해당 agent의 접속을 아예 받지 않는다.

```bash
# 긴 무작위 문자열을 쓴다
openssl rand -base64 24
```

```bash
# 서버
npm run dev        # 파일 변경 감지
npm start          # tsx로 바로 실행
npm test
npm run typecheck

# 관리 UI (web/)
npm run web:install
npm run web:dev    # :5174, API는 :4100으로 프록시된다
npm run web:build  # web/dist 로 빌드

# 배포용
npm run build      # 서버를 dist/ 로 컴파일
npm run build:all  # 서버 + UI
npm run serve      # 컴파일본 실행
```

UI를 고칠 때는 `npm run dev`와 `npm run web:dev`를 함께 띄운다.
브라우저는 :5174로 보고, API 호출은 :4100으로 넘어간다.

첫 접속 때 웹에서 **계정을 만든다.** 계정이 없으면 보호된 경로가
`503 setup_required`를 돌려주고, 클라이언트가 초기 설정 화면을 띄운다.

비밀번호는 10자 이상이어야 하고 흔한 것(`password`, `12345678` 등)은 거부된다.

---

## API

계정을 만든 뒤에는 `Authorization: Bearer <토큰>`이 필요하다.

### 계정

```
GET  /auth/status          설정 여부 확인 (인증 불필요)
POST /auth/setup           최초 계정 생성 { username, password }
POST /auth/login           로그인 { username, password, label }
POST /auth/logout
POST /auth/password        비밀번호 변경 → 모든 기기 로그아웃
GET  /auth/tokens          발급된 토큰 목록
POST /auth/revoke-all      모든 기기 로그아웃
```

### 서버가 직접 처리

agent가 꺼져 있어도 동작한다.

```
GET  /relay/status         연결된 agent 목록
GET  /motd                 접속 직후 보여줄 서버 상태 요약

GET|POST   /checklist                  전역 체크리스트
POST       /checklist/clear-done
POST       /checklist/{id}/toggle
PATCH      /checklist/{id}
DELETE     /checklist/{id}

GET|POST   /notifications              알림함
POST       /notifications/read-all
POST       /notifications/clear-read
POST       /notifications/{id}/read
DELETE     /notifications/{id}

GET|POST   /sessions/{id}/checklist    세션별 체크리스트
```

### agent로 전달

연결된 agent가 없으면 `503 no_agent`.

```
/sessions  /workspaces  /jobs  /files  /health   → /agent 쪽
/terminals                                        → /terminal-agent 쪽
```

`/stream`으로 끝나는 경로는 SSE로 중계한다. 15초마다 `: ping`을 보내
중간 장비가 끊지 않게 한다.

`EventSource`와 브라우저 `WebSocket`은 헤더를 못 붙이므로, 스트림 경로에
한해 `?token=`도 받는다.

---

## agent 연동

agent가 이쪽으로 WebSocket을 건다:

```
ws://<서버>:4100/agent?name=<이름>&token=<RELAY_AGENT_TOKEN>
ws://<서버>:4100/terminal-agent?name=<이름>&token=<RELAY_TERMINAL_TOKEN>
```

붙으면 서버가 `welcome`을 보내고, 그 뒤로 이 메시지들이 오간다:

```
서버 → agent : {"type":"welcome",      "agentId"}
               {"type":"request",      "id","method","path","body"}
               {"type":"stream_open",  "id","path"}
               {"type":"stream_close", "id"}
agent → 서버 : {"type":"response",     "id","status","body"}
               {"type":"error",        "id","message"}
               {"type":"stream_chunk", "id","chunk","done"}
```

agent는 받은 요청을 자기 HTTP API로 대신 호출해 결과를 돌려준다.
요청 하나당 30초 안에 응답이 없으면 실패로 처리한다.

같은 종류의 agent가 여럿 붙으면 **먼저 붙은 쪽**을 쓴다.

---

## 설정

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` / `HOST` | `4100` / `0.0.0.0` | |
| `RELAY_AGENT_TOKEN` | (없음) | 일반 agent 접속 토큰 |
| `RELAY_CLIENT_KEY` | (없음) | 레거시 클라이언트 키 |
| `RELAY_TERMINAL_TOKEN` | (없음) | 터미널 agent 접속 토큰. **비우면 접속 거부** |
| `RELAY_TOKEN_TTL_DAYS` | `30` | 로그인 토큰 유효기간 |
| `RELAY_WEB_ROOT` | `../web/dist` | `/web`에 서빙할 관리 UI |
| `RELAY_GLASSES_ROOT` | `../glasses/dist` | `/`에 서빙할 안경앱 |
| `RELAY_DATA_DIR` | `./data` | 계정·알림·체크리스트 저장 위치 |
| `RELAY_RATE_LIMIT` | `300` | 분당 요청 상한 |

`RELAY_WEB_ROOT`와 `RELAY_GLASSES_ROOT`는 **다른 경로다.** 헷갈리면
`/web`에 엉뚱한 앱이 뜬다.

---

## 보안

- **비밀번호는 scrypt로 해싱**한다. salt 16바이트, 키 64바이트.
  `data/auth.json`은 `0600`으로 저장된다
- **로그인은 아이디가 틀려도 해시 검증을 수행**한다. 응답 시간으로
  아이디 존재 여부를 알아내지 못하게 하려는 것이다
- **비밀번호를 바꾸면 발급된 토큰을 전부 폐기**한다
- **IP별 요청 상한**이 있고, 로그인은 별도 버킷으로 더 촘촘히 센다
- **토큰 비교는 상수 시간**(`timingSafeEqual`)으로 한다

### 터미널 agent를 붙일 때

셸을 여는 권한이라 특별히 주의해야 한다.

- `RELAY_TERMINAL_TOKEN`을 **비워두면 접속을 아예 받지 않는다.** 실수로
  열리는 것을 막으려는 기본값이다
- 일반 agent 토큰과 **반드시 다른 값**을 쓴다
- 토큰이 새면 그 기기의 셸이 통째로 넘어간다. 인터넷에 열린 서버라면
  터미널 연동은 켜지 않는 편이 안전하다

### 저장되는 것

`data/` 아래에 평문 JSON으로 쌓인다. 비밀번호는 해시지만 나머지는 그대로다.

```
data/auth.json           계정 + 발급 토큰 (0600)
data/notifications.json  알림 (최대 300건)
data/checklists/*.json   체크리스트
```

`.gitignore`에 `data/`가 들어 있다. **커밋하지 말 것.**

---

## 구조

```
src/                    서버
  index.ts              Express + WebSocket. 라우트와 중계
  core/
    agents.ts           AgentRegistry — 연결된 agent와 요청/응답 짝짓기
    term-agents.ts      터미널 agent용 레지스트리 (같은 클래스를 한 번 더)
    auth.ts             계정·토큰. scrypt 해싱
    security.ts         상수 시간 비교, 요청 상한, 인증 실패 기록
    checklist.ts        체크리스트 저장소
    notifications.ts    알림함
    config.ts           환경변수
    banner.ts           시작 배너

web/                    관리 UI (React + Vite)
  src/
    App.tsx             탭 전환, 세션 목록
    api.ts              REST 클라이언트 + SSE
    Terminal.tsx        xterm.js 터미널
    Chat.tsx            세션 대화
    Files.tsx           파일 탐색기
    Checklist.tsx       체크리스트
    Notifications.tsx   알림
```

### 설계 메모

- **WebSocket 서버를 두 개 쓸 때는 `noServer` 모드여야 한다.**
  `new WebSocketServer({ server, path })`를 두 번 쓰면 각자 upgrade
  리스너를 달고, 경로가 자기 것이 아니면 소켓을 파기한다. 뒤에 붙은 쪽은
  요청을 보지도 못하고 400으로 끊긴다
- **스트림 라우트를 일반 중계보다 먼저 등록한다.** 순서가 바뀌면
  `/terminals/{id}/stream`이 엉뚱한 agent로 샌다
- **알림과 체크리스트는 서버가 직접 갖는다.** agent가 꺼져 있어도
  보이게 하려는 것이다

---

## 라이선스

MIT — [LICENSE](LICENSE) 참고.
