# relay-service

**집 안의 기기에 밖에서 붙게 해주는 중계 서버.** 관리 UI가 함께 들어 있다.

공유기 안에 있는 맥이나 서버에 외부에서 접속하려면 보통 포트포워딩이 필요하다.
이 서버는 반대로 동작한다 — **기기 쪽에서 서버로 나가서 붙고**, 서버가 그 연결로
요청을 되돌려 보낸다. 공유기 설정을 건드릴 필요가 없다.

```
   agent (집 안)                  relay-service (밖)
        │                                │
        │ ─── WebSocket 아웃바운드 ───▶   │  ◀─── 브라우저·모바일
        │                                │
        │ ◀── 요청을 되돌려 보냄 ────      │
```

---

## 빠르게 시작

```bash
docker run -d --name relay-service \
  -p 4100:4100 \
  -v "$(pwd)/data:/app/data" \
  -e RELAY_TERMINAL_TOKEN="$(openssl rand -base64 24)" \
  foncdev/relay-service
```

브라우저에서 <http://localhost:4100/web> 을 열면 **첫 화면에서 계정을 만든다.**
비밀번호는 10자 이상이어야 한다.

### docker compose

```yaml
services:
  relay:
    image: foncdev/relay-service
    restart: unless-stopped
    ports:
      - "4100:4100"
    volumes:
      - ./data:/app/data
    environment:
      # 긴 무작위 문자열을 쓴다: openssl rand -base64 24
      RELAY_AGENT_TOKEN: change-me
      RELAY_TERMINAL_TOKEN: change-me-differently
      TZ: Asia/Seoul
```

---

## 무엇이 들어 있나

| | |
|---|---|
| **중계 서버** | agent 연결로 요청을 전달. SSE도 흘려보낸다 |
| **관리 UI** | 브라우저 화면. `/web`에서 바로 열린다 |
| **인증** | 계정 하나 + 기기별 토큰. scrypt 해싱 |
| **알림·체크리스트** | 서버가 직접 보관. agent가 꺼져도 볼 수 있다 |

관리 UI의 탭:

| 탭 | 하는 일 | 필요한 것 |
|---|---|---|
| **터미널** | 실제 셸 (vim·top·색상 동작) | [terminal-agent](https://github.com/foncdev/terminal-agent) |
| **할 일** | 체크리스트 | 없음 |
| **알림** | 알림함 | 없음 |
| 세션 · 파일 | 대화형 세션, 파일 탐색 | 별도 agent |

agent가 안 붙어 있으면 그 탭은 "미연결"로 뜬다. **할 일과 알림은 서버만으로도
쓸 수 있다.**

---

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `4100` | 리스닝 포트 |
| `HOST` | `0.0.0.0` | 리스닝 주소 |
| `RELAY_AGENT_TOKEN` | (없음) | 일반 agent 접속 토큰 |
| `RELAY_TERMINAL_TOKEN` | (없음) | 터미널 agent 토큰. **비우면 접속 거부** |
| `RELAY_CLIENT_KEY` | (없음) | 레거시 클라이언트 키 |
| `RELAY_TOKEN_TTL_DAYS` | `30` | 로그인 토큰 유효기간 |
| `RELAY_RATE_LIMIT` | `300` | 분당 요청 상한 |
| `TZ` | `Asia/Seoul` | 알림 시각 기준 |

경로 관련 값은 이미지에서 이미 잡혀 있어 보통 건드릴 일이 없다.

| 변수 | 이미지 기본값 |
|---|---|
| `RELAY_DATA_DIR` | `/app/data` |
| `RELAY_WEB_ROOT` | `/app/web` (관리 UI가 여기 들어 있다) |
| `RELAY_GLASSES_ROOT` | `/app/glasses` |

---

## 볼륨

| 경로 | 무엇 | 필수 |
|---|---|---|
| `/app/data` | 계정·알림·체크리스트 | **예** |

`/app/data`를 붙이지 않으면 **컨테이너를 지울 때 계정까지 사라진다.**
다시 만들어야 한다.

```
/app/data/
  auth.json           계정 + 발급 토큰 (0600)
  notifications.json  알림
  checklists/         체크리스트
```

---

## 지원 플랫폼

`linux/amd64`, `linux/arm64`

NAS(시놀로지·QNAP), 라즈베리파이, Apple Silicon에서도 그대로 돈다.

---

## agent 붙이기

터미널을 쓰려면 [terminal-agent](https://github.com/foncdev/terminal-agent)를
쓰는 기기에 설치한다.

```bash
# 맥·리눅스
curl -fsSL https://raw.githubusercontent.com/foncdev/terminal-agent/main/install.sh | sh
```

`.env`에 중계 서버 주소와 **같은 토큰**을 적는다:

```bash
TERMINAL_ENABLED=true
TERMINAL_ALLOWED_ROOTS=~/projects
RELAY_URL=ws://<서버>:4100/terminal-agent
RELAY_TERMINAL_TOKEN=<위에서 설정한 값>
```

```bash
terminal-agent
```

그러면 관리 UI의 터미널 탭에서 그 기기의 셸이 보인다. 기기 앞에서 치던 명령이
브라우저에도 나타나고, 반대도 된다.

---

## 보안

**인터넷에 그대로 열지 말 것.** 리버스 프록시 뒤에 두고 HTTPS를 붙이는 것을
권한다.

- 토큰을 **반드시 설정한다.** 비워두면 아무나 agent로 붙을 수 있다
- 일반 agent와 터미널 agent 토큰은 **다른 값**을 쓴다. 터미널 쪽은 셸을 여는
  권한이라, 한쪽이 새도 번지지 않게 갈라뒀다
- 비밀번호는 scrypt로 해싱되고 `auth.json`은 `0600`으로 저장된다
- 컨테이너는 **root로 돌지 않는다** (`node` 사용자)
- IP별 요청 상한이 있고, 로그인은 더 촘촘히 센다

터미널 연동은 **그 기기의 셸을 통째로 여는 것**이다. 토큰이 새면 기기가
넘어간다. 인터넷에 열린 서버라면 켜지 않는 편이 안전하다.

---

## 태그

| 태그 | 내용 |
|---|---|
| `latest` | 최신 안정 버전 |
| `0.1.0` | 특정 버전 |

---

## 링크

- **소스·문서**: <https://github.com/foncdev/relay-service>
- **터미널 agent**: <https://github.com/foncdev/terminal-agent>
- **이슈**: <https://github.com/foncdev/relay-service/issues>

MIT 라이선스.
