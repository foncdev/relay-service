# relay-service

[![CI](https://github.com/foncdev/relay-service/actions/workflows/ci.yml/badge.svg)](https://github.com/foncdev/relay-service/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/docker/v/foncdev/relay-service?label=docker)](https://hub.docker.com/r/foncdev/relay-service)

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
| 터미널 | 실제 셸 (xterm.js) | [terminal-agent](https://github.com/foncdev/terminal-agent) |
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
| `/terminal-agent` | [terminal-agent](https://github.com/foncdev/terminal-agent) | `/terminals` |

**토큰이 서로 다르다.** 터미널 쪽은 셸을 여는 권한이라, 한쪽이 새도 다른
쪽으로 번지지 않게 갈라뒀다.

---

## 처음 실행

서버를 처음 띄우면 **계정이 없어서 잠겨 있다.** 보호된 경로는 모두
`503 setup_required`를 돌려준다. 시작 로그에도 아래 순서가 찍힌다.

**1. 관리자 계정을 만든다.**
브라우저에서 <http://localhost:4100/web>을 열면 초기 설정 화면이 뜬다.
아이디는 영문/숫자/밑줄/하이픈 3~32자, 비밀번호는 10자 이상이다. 흔한 비밀번호
(`password`, `12345678` 등)는 거부된다. 계정은 하나뿐이고, 한 번 만들면
설정 화면은 다시 열리지 않는다.

**2. 토큰을 채운다.** 소스에서는 `.env`, Docker에서는 환경변수로 넣는다.
사람 로그인과는 별개로, agent·외부 서비스가 붙을 때 쓰는 값이다.

```bash
openssl rand -base64 24   # 하나씩 따로 만든다
```

| 변수 | 누가 쓰나 | 비워두면 |
|---|---|---|
| `RELAY_AGENT_TOKEN` | 일반 agent | 누구나 agent로 붙는다 — 외부 배포 시 반드시 채운다 |
| `RELAY_TERMINAL_TOKEN` | [terminal-agent](https://github.com/foncdev/terminal-agent) | 터미널 접속을 받지 않는다 |
| `RELAY_HOOK_KEY` | 외부 알림 훅 | 훅이 닫힌다 (`503`) |

세 값은 **서로 다르게** 둔다. 바꾼 뒤에는 서버를 다시 띄운다.

**3. agent를 붙인다.** agent 쪽에 서버 주소와 토큰을 준다.

```
ws://<서버>:4100/agent?name=<이름>&token=<RELAY_AGENT_TOKEN>
ws://<서버>:4100/terminal-agent?name=<이름>&token=<RELAY_TERMINAL_TOKEN>
```

붙으면 서버 로그에 `agent 접속`이 찍히고, 관리 UI의 해당 탭이 "미연결"에서
바뀐다. 할 일·알림 탭은 agent 없이도 바로 쓸 수 있다.

### 초기화

비밀번호를 잊었거나 처음부터 다시 설정하려면 **서버를 멈추고** 초기화
명령을 돌린 뒤 다시 띄운다. `/web`에 초기 설정 화면이 다시 뜬다.

```bash
npm run reset            # 계정과 로그인 토큰만. 알림·체크리스트·스니펫은 남는다
npm run reset -- --all   # 전부
```

Docker에서는:

```bash
docker compose stop relay
docker compose run --rm relay node dist/reset.js --yes          # 계정만
docker compose run --rm relay node dist/reset.js --all --yes    # 전부
docker compose start relay
```

- **웹에는 두지 않는다.** 인터넷에 열린 서버라, 웹에서 되면 누구나 계정을
  날리고 새로 만들 수 있다. 서버 파일에 손댈 수 있는 사람만 할 수 있어야 한다
- **지우지 않고 옮긴다.** 계정만이면 `data/auth.json.bak.<시각>`, 전부면
  `data/reset-<시각>/`으로 간다. 잘못 돌렸으면 제자리로 옮기면 된다
- **서버가 떠 있으면 거부한다.** 떠 있는 서버는 계정을 메모리에 들고 있어서
  파일을 지워도 다음 저장 때 도로 써진다. 같은 기기의 포트로만 확인하므로,
  Docker에서는 위처럼 직접 멈춰야 한다
- `.env`의 토큰(`RELAY_AGENT_TOKEN` 등)은 건드리지 않는다. 바꾸려면 직접 고친다

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

### 자동 배포

`main`에 푸시하면 GitHub Actions가 이미지를 빌드해 올린다. Docker Hub의
설명(`DOCKER_HUB.md`)도 함께 갱신된다.

| 푸시한 것 | 붙는 태그 |
|---|---|
| `main` 브랜치 | `latest` |
| `v0.1.0` 태그 | `0.1.0`, `0.1`, `latest` |

저장소 시크릿 두 개가 필요하다 (Settings → Secrets and variables → Actions):

| 이름 | 값 |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub 사용자명 |
| `DOCKERHUB_TOKEN` | [액세스 토큰](https://app.docker.com/settings/personal-access-tokens) — 비밀번호 말고 |

토큰 권한은 **Read, Write**면 된다.

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

계정 만들기와 토큰 설정은 [처음 실행](#처음-실행)을 따른다.

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

### 외부 알림 훅

다른 서비스가 안경에 한 줄 띄울 때 쓴다. 넣으면 SSE로 안경·폰·웹에
바로 퍼진다.

```
POST /hooks/notify           외부 알림 추가
POST /hooks/notify/{이름}     어디서 왔는지 함께 남긴다
```

**전용 키를 쓴다.** 클라이언트 키는 세션·파일·셸까지 여는 마스터라
남의 자동화에 건네면 안 된다. `RELAY_HOOK_KEY`를 따로 발급하면 그
키로는 알림 추가밖에 못 한다. 비워두면 훅이 닫힌다(`503`).

```bash
curl -X POST http://호스트:4100/hooks/notify/github \
  -H 'X-Hook-Key: 발급한키' \
  -H 'Content-Type: application/json' \
  -d '{"title":"PR 머지됨","body":"#42 알림 훅 추가"}'
```

보내는 쪽을 고칠 수 있으면 `{title, body, kind}`로 주면 된다. 남의
서비스라 형식을 바꿀 수 없으면 그대로 보내도 된다 — 흔한 이름
(`text`·`message`·`subject`·`summary` 등)을 훑어 제목을 찾고,
`level`·`severity`·`status`에서 심각도를 읽어 종류를 정한다. 아는
이름이 하나도 없으면 몸통을 그대로 본문에 넣는다. 알림이 통째로
사라지는 것보다 무엇이 왔는지 보이는 편이 낫다.

평문(`text/plain`)과 폼도 받는다.

| 응답 | 뜻 |
|---|---|
| `201` | 알림을 넣었다 |
| `400` | 알림으로 만들 내용이 없다 |
| `401` | 훅 키가 틀리다 |
| `503` | `RELAY_HOOK_KEY`가 없어 훅이 닫혀 있다 |

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
| `RELAY_HOOK_KEY` | (없음) | 외부 알림 훅 전용 키. 클라이언트 키와 다르게 둔다. **비우면 훅 닫힘** |
| `RELAY_TERMINAL_TOKEN` | (없음) | 터미널 agent 접속 토큰. **비우면 접속 거부** |
| `RELAY_TOKEN_TTL_DAYS` | `30` | 로그인 토큰 유효기간 |
| `RELAY_WEB_ROOT` | `./web/dist` | `/web`에 서빙할 관리 UI |
| `RELAY_GLASSES_ROOT` | `../glasses-g2/dist` | `/`에 서빙할 안경앱 |
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

## 관련 프로젝트

- **[terminal-agent](https://github.com/foncdev/terminal-agent)** — 이 서버에 붙는
  터미널 agent. `/terminal-agent`로 접속해 셸을 열어준다. 데스크톱에서 쓰던
  터미널을 여기 관리 UI에서 이어 쓸 수 있다

### 쓰는 것

- [Express](https://expressjs.com/) — HTTP 서버
- [ws](https://github.com/websockets/ws) — WebSocket
- [React](https://react.dev/) · [Vite](https://vite.dev/) — 관리 UI
- [xterm.js](https://xtermjs.org/) — 터미널 탭 렌더러

---

## 라이선스

MIT — [LICENSE](LICENSE) 참고.
