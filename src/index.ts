/**
 * relay-service — agent-cli와 클라이언트 사이의 중계 서버.
 *
 *   agent-cli(맥) ──WebSocket 아웃바운드──> relay-service ──> relay 앱 / G2
 *
 * 맥이 서버로 붙기 때문에 공유기 안에 있어도 포트포워딩이 필요 없다.
 * 안경앱 정적 파일도 같이 서빙해 G2가 한 주소만 알면 되게 한다.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { clientKeyUsable, config, warnings } from './core/config.js';
import { agents, AgentRegistry } from './core/agents.js';
import { termAgents } from './core/term-agents.js';
import { checklists, ChecklistError, GLOBAL_LIST } from './core/checklist.js';
import { notifications, type NotificationKind } from './core/notifications.js';
import { BANNER, TAGLINE } from './core/banner.js';
import { globalLoginFailures, logAuthFailure, loginLimiter, rateLimiter, safeEqual } from './core/security.js';
import { auth, AuthError } from './core/auth.js';
import { publish, subscribe, subscriberCount } from './core/events.js';
import { toNotification } from './core/hook.js';
import { snippets, SnippetError } from './core/snippets.js';
import { Scheduler } from './core/scheduler.js';
import { advertise, serviceName } from './core/bonjour.js';
import { firstRunGuide } from './core/guide.js';
import { L } from './core/lang.js';

/** 같은 와이파이의 폰이 이 서버를 찾게 알린다. 멈출 때 부른다. */
let stopAdvertising = (): void => undefined;

/** 예약한 명령을 주기마다 돌린다. 서버가 뜨면 start한다. */
const scheduler = new Scheduler(termAgents);

const app = express();

// 리버스 프록시 뒤라면 실제 IP를 X-Forwarded-For에서 읽는다. config.trustProxy 참고.
if (config.trustProxy) {
  const n = Number(config.trustProxy);
  app.set('trust proxy', Number.isInteger(n) ? n : config.trustProxy);
}

/*
 * 보안 헤더.
 *
 *  - 프레임 금지: 관리 화면을 남의 페이지에 투명하게 겹쳐 권한 승인이나
 *    명령 실행 버튼을 누르게 만들 수 있다(클릭재킹)
 *  - nosniff: 올린 글을 스크립트로 해석하지 않게
 *  - no-referrer: 스트림 주소의 ?token=이 다른 사이트로 넘어가지 않게
 */
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '5mb' }));
// 훅으로 오는 몸통은 JSON이 아닐 수 있다. 남의 서비스는 형식을 고를
// 수 없으므로 폼과 평문도 받아 둔다.
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.text({ type: ['text/*'], limit: '256kb' }));

// G2와 모바일 앱은 다른 오리진에서 붙는다. 인증은 키가 담당한다.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.header('origin') ?? '*');
  // Authorization을 빠뜨리면 토큰을 쓰는 클라이언트가 통째로 막힌다.
  // 브라우저는 허용되지 않은 헤더를 보내려는 요청을 아예 보내지 않는다.
  // 같은 출처(예: 서버가 서빙하는 /web)에서는 드러나지 않아 놓치기 쉽다.
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

/*
 * 외부 알림 훅.
 *
 * 다른 서비스가 안경으로 한 줄 띄우고 싶을 때 쓴다. 아래 인증
 * 미들웨어보다 앞에 둔다 — 그건 세션·파일·셸까지 여는 마스터 키를
 * 요구하는데, 훅을 쓰는 쪽에 그 키를 건네면 안 되기 때문이다.
 *
 * 그래서 전용 키(RELAY_HOOK_KEY)로 따로 인증하고, 할 수 있는 일은
 * 알림 추가 하나로 묶어 둔다.
 *
 *   curl -X POST http://호스트:4100/hooks/notify \
 *     -H 'X-Hook-Key: …' -H 'Content-Type: application/json' \
 *     -d '{"title":"배포 완료","body":"v1.2.3"}'
 *
 * 경로 끝에 이름을 붙이면(/hooks/notify/github) 어디서 왔는지 남는다.
 */
app.post(/^\/hooks\/notify(?:\/([\w.-]{1,40}))?$/, (req, res) => {
  // 키를 비워두면 훅을 닫는다. 설정을 안 했는데 열려 있으면 사고다.
  if (!config.hookKey) {
    res.status(503).json({
      error: { code: 'hook_disabled', message: L('RELAY_HOOK_KEY가 없어 훅이 닫혀 있습니다.', 'The hook is closed because RELAY_HOOK_KEY is not set.') },
    });
    return;
  }

  const ip = req.ip ?? 'unknown';
  if (!rateLimiter.allow(ip)) {
    res.status(429).json({
      error: { code: 'rate_limited', message: L('요청이 너무 잦습니다. 잠시 후 다시 시도하세요.', 'Too many requests. Try again shortly.') },
    });
    return;
  }

  /*
   * 키는 헤더로 받는다. 쿼리로도 받아주는데, 훅을 거는 쪽이 헤더를
   * 못 붙이는 경우가 있기 때문이다(간단한 웹훅 설정 화면 등).
   * 다만 URL에 남으므로 헤더를 권한다.
   */
  const provided =
    req.header('x-hook-key') ??
    req.header('authorization')?.replace(/^Bearer\s+/i, '') ??
    (req.query.key as string | undefined) ??
    '';

  if (!safeEqual(provided, config.hookKey)) {
    logAuthFailure(ip, req.path);
    res.status(401).json({ error: { code: 'unauthorized', message: L('훅 키가 맞지 않습니다.', 'Wrong hook key.') } });
    return;
  }

  // 경로에 붙은 이름. 어디서 온 알림인지 본문 끝에 남긴다.
  const source = req.params[0] ? String(req.params[0]) : undefined;
  const mapped = toNotification(req.body, source);
  if (!mapped) {
    res.status(400).json({
      error: {
        code: 'empty_payload',
        message: L('알림으로 만들 내용이 없습니다. title이나 text를 담아 보내세요.', 'Nothing to turn into a notification. Send a title or text.'),
      },
    });
    return;
  }

  try {
    const item = notifications.add({
      title: mapped.title,
      // 어디서 왔는지 남긴다. 제목은 좁아서 본문에 붙인다.
      body: mapped.source ? `${mapped.body}\n\n— ${mapped.source}`.trim() : mapped.body,
      kind: mapped.kind,
    });
    publish('notifications');
    console.log(`[relay] 훅 알림${source ? ` (${source})` : ''}: ${item.title}`);
    res.status(201).json({ id: item.id, unread: notifications.unreadCount() });
  } catch (err) {
    res.status(400).json({
      error: { code: 'hook_failed', message: err instanceof Error ? err.message : L('알림 추가 실패', 'Failed to add the notification') },
    });
  }
});

/** 중계 API만 인증한다. 정적 파일과 상태 확인은 열어둔다. */
function isProtected(p: string): boolean {
  // 계정 관리 중 로그인/설정/상태는 인증 없이 열어야 한다.
  if (/^\/auth\/(status|setup|login|logout)$/.test(p)) return false;
  // terminals를 빠뜨리면 셸이 무인증으로 열린다. 반드시 포함해야 한다.
  // health도 막는다 — 응답에 allowedRoots(서버 경로)가 들어 있다.
  return /^\/(sessions|workspaces|jobs|files|terminals|sys|run|snippets|health|checklist|notifications|motd|auth|events)\b/.test(p);
}

/**
 * EventSource는 헤더를 못 붙인다. 이 경로들만 쿼리 토큰을 받는다.
 *
 * 토큰이 URL에 드러나므로 꼭 필요한 곳만 연다. 접근 로그나 브라우저
 * 기록에 남기 때문이다.
 */
function acceptsQueryToken(p: string): boolean {
  return p.endsWith('/stream') || p === '/events';
}

app.use((req, res, next) => {
  if (!isProtected(req.path)) return next();

  const ip = req.ip ?? 'unknown';
  // 무차별 시도를 늦춘다.
  if (!rateLimiter.allow(ip)) {
    res.status(429).json({
      error: { code: 'rate_limited', message: L('요청이 너무 잦습니다. 잠시 후 다시 시도하세요.', 'Too many requests. Try again shortly.') },
    });
    return;
  }

  // 설정 전에는 잠가둔다. 키를 빠뜨린 채 인터넷에 열리는 사고를 막는다.
  if (!auth.isConfigured) {
    res.status(503).json({
      error: { code: 'setup_required', message: L('초기 설정이 필요합니다. /setup 에서 계정을 만드세요.', 'Setup required. Create an account at /setup.') },
    });
    return;
  }

  // EventSource는 헤더를 못 붙이므로 스트림 경로는 쿼리 토큰도 받는다.
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const queryToken = acceptsQueryToken(req.path);
  const provided =
    bearer ??
    req.header('x-api-key') ??
    (queryToken ? (req.query.token as string | undefined) : undefined) ??
    (queryToken ? (req.query.apiKey as string | undefined) : undefined);

  if (!provided) {
    logAuthFailure(ip, req.path);
    res.status(401).json({ error: { code: 'unauthorized', message: L('로그인이 필요합니다.', 'Sign-in required.') } });
    return;
  }

  // 세션 토큰이 우선. 환경변수 키는 기존 클라이언트 호환용으로 남긴다.
  // 짧은 키는 받지 않는다(clientKeyUsable) — 셸까지 여는 마스터 키라서.
  const ok =
    auth.verifyToken(provided) || (clientKeyUsable && safeEqual(provided, config.clientKey));

  if (!ok) {
    logAuthFailure(ip, req.path);
    res.status(401).json({ error: { code: 'unauthorized', message: L('인증에 실패했습니다.', 'Authentication failed.') } });
    return;
  }
  next();
});

// --- 계정 ---

/** 설정이 끝났는지. 클라이언트가 첫 화면을 정하는 데 쓴다. */
app.get('/auth/status', (_req, res) => {
  res.json({ configured: auth.isConfigured, username: auth.username });
});

/**
 * 최초 관리자 계정을 만든다. 이미 있으면 409로 거부한다.
 *
 * 시작 로그에 찍힌 설정 코드가 있어야 한다(auth.setupCode). 계정이 없는
 * 동안 이 경로는 인터넷의 누구에게나 열려 있기 때문이다.
 */
app.post('/auth/setup', (req, res, next) => {
  const ip = req.ip ?? 'unknown';
  if (!loginLimiter.allow(ip)) {
    res.status(429).json({ error: { code: 'rate_limited', message: L('잠시 후 다시 시도하세요.', 'Try again shortly.') } });
    return;
  }
  const { username, password, code } = (req.body ?? {}) as Record<string, string>;
  auth
    .setup(String(username ?? ''), String(password ?? ''), String(code ?? ''))
    .then((token) => res.status(201).json({ token, username }))
    .catch((err) => {
      logAuthFailure(ip, '/auth/setup');
      next(err);
    });
});

app.post('/auth/login', (req, res, next) => {
  const ip = req.ip ?? 'unknown';
  // 로그인은 따로, 더 촘촘히 센다. 여러 IP로 나눠 시도하는 것은 전체 실패로 막는다.
  if (!loginLimiter.allow(ip) || globalLoginFailures.blocked('all')) {
    res.status(429).json({ error: { code: 'rate_limited', message: L('잠시 후 다시 시도하세요.', 'Try again shortly.') } });
    return;
  }
  const { username, password, label } = (req.body ?? {}) as Record<string, string>;
  auth
    .login(String(username ?? ''), String(password ?? ''), String(label ?? L('기기', 'Device')).slice(0, 60))
    .then((token) => res.json({ token, username }))
    .catch((err) => {
      logAuthFailure(ip, '/auth/login');
      globalLoginFailures.allow('all');
      next(err);
    });
});

app.post('/auth/logout', (req, res) => {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  auth.revoke(token);
  res.status(204).end();
});

app.post('/auth/password', (req, res, next) => {
  const { current, next: nextPw } = (req.body ?? {}) as Record<string, string>;
  auth
    .changePassword(String(current ?? ''), String(nextPw ?? ''))
    .then(() => res.json({ ok: true, message: L('비밀번호를 바꿨습니다. 모든 기기가 로그아웃됩니다.', 'Password changed. All devices will be signed out.') }))
    .catch(next);
});

app.get('/auth/tokens', (_req, res) => {
  res.json({ tokens: auth.listTokens() });
});

/** 모든 기기 로그아웃. 유출이 의심될 때 쓴다. */
app.post('/auth/revoke-all', (_req, res) => {
  auth.revokeAll();
  res.json({ ok: true });
});

// --- 상태 ---

app.get('/relay/status', (_req, res) => {
  const list = agents.list();
  res.json({
    ok: list.length > 0,
    agents: list,
    // 안경앱이 이 값으로 연결 상태를 표시한다.
    connected: list.length > 0,
  });
});

/** 서버가 뜬 시각. 가동 시간 계산에 쓴다. */
const startedAt = Date.now();

/**
 * 접속 직후 띄우는 MOTD.
 *
 * 로그인하면 서버 상태를 한눈에 보여준다. 인증이 필요하다 —
 * agent 이름이나 할 일 개수는 남에게 보일 정보가 아니다.
 */
app.get('/motd', (_req, res) => {
  const list = agents.list();
  const notifs = notifications.list();
  const todos = checklists.list(GLOBAL_LIST);
  const up = Math.floor((Date.now() - startedAt) / 1000);
  const uptime =
    up < 60
      ? L(`${up}초`, `${up}s`)
      : up < 3600
        ? L(`${Math.floor(up / 60)}분`, `${Math.floor(up / 60)}m`)
        : L(`${Math.floor(up / 3600)}시간`, `${Math.floor(up / 3600)}h`);

  const unread = notifs.filter((n) => !n.readAt).length;
  const open = todos.filter((t) => !t.done).length;

  res.json({
    lines: [
      L(`relay-service · 가동 ${uptime}`, `relay-service · up ${uptime}`),
      list.length > 0
        ? L(
            `agent ${list.length}대 연결됨 (${list.map((a) => a.name).join(', ')})`,
            `${list.length} agent${list.length === 1 ? '' : 's'} connected (${list.map((a) => a.name).join(', ')})`,
          )
        : L('agent 미연결 — 맥에서 agent-cli를 실행하세요', 'No agent connected — run agent-cli on the Mac'),
      L(`알림 ${unread}건 · 할 일 ${open}건 남음`, `${unread} unread · ${open} to-do${open === 1 ? '' : 's'} left`),
    ],

    agents: list.length,
    unread: notifs.filter((n) => !n.readAt).length,
    todos: todos.filter((t) => !t.done).length,
  });
});


/**
 * 체크리스트·알림이 바뀌면 구독자에게 알린다.
 *
 * 바꾸는 자리가 열 곳이 넘어 하나씩 넣으면 빠뜨리기 쉽다. 라우트 앞에
 * 한 번 두고 응답이 나갈 때 판단한다.
 *
 * 성공한 변경만 알린다. GET은 아무것도 바꾸지 않고, 4xx·5xx로 끝난
 * 요청도 마찬가지다.
 */
app.use((req, res, next) => {
  const p = req.path;
  const watched =
    p.startsWith('/checklist') ||
    p.startsWith('/notifications') ||
    /^\/sessions\/[^/]+\/checklist/.test(p);

  if (!watched || req.method === 'GET' || req.method === 'HEAD') return next();

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    if (p.startsWith('/notifications')) {
      publish('notifications');
      return;
    }
    // 할 일 변경은 알림도 하나 남긴다. 둘 다 알려야 안경이 배지까지
    // 새로 읽는다. 하나만 보내면 목록은 바뀌고 배지는 그대로다.
    publish('checklist');
    publish('notifications');
  });
  next();
});

/**
 * 할 일이 바뀌면 알림으로도 남긴다.
 *
 * 웹에서 할 일을 고쳐도 안경은 홈 요약의 숫자만 달라져서, 무엇이
 * 바뀌었는지 알 수 없었다. 알림으로 남기면 나중에 목록에서 다시 본다.
 *
 * 알림 저장이 실패해도 할 일 자체는 이미 바뀌었다. 여기서 던지면
 * 성공한 요청이 500으로 뒤집히므로 삼킨다.
 */
function notifyTodo(title: string, body: string, sessionId?: string): void {
  try {
    notifications.add({
      title,
      body,
      kind: 'info',
      // 전역 목록은 세션에 속하지 않는다. 그대로 넘기면 안경에서
      // 없는 세션을 열려고 한다.
      sessionId: sessionId === GLOBAL_LIST ? undefined : sessionId,
    });
  } catch {
    // 알림은 부수적이다. 할 일 변경은 그대로 둔다.
  }
}

/** 목록 요약. 여러 줄을 한 번에 넣을 때 본문에 쓴다. */
function summarize(items: { text: string }[]): string {
  return items.map((i) => `· ${i.text}`).join('\n');
}

// --- 전역 체크리스트 ---
//
// 세션과 무관하게 항상 보이는 공용 목록.
// 세션별 라우트와 같은 저장소를 쓰되 id만 고정한다.

app.get('/checklist', (_req, res) => {
  res.json({ items: checklists.list(GLOBAL_LIST) });
});

// 세션마다 남은 할 일 수. /sessions는 agent-cli가 답해 거기에 붙일 수 없다.
app.get('/checklist/sessions', (_req, res) => {
  res.json({ counts: checklists.openCounts() });
});

app.post('/checklist', (req, res) => {
  const text = String((req.body as { text?: unknown })?.text ?? '');
  if (!text.trim()) {
    res.status(400).json({ error: { code: 'empty_text', message: L('추가할 내용이 없습니다.', 'Nothing to add.') } });
    return;
  }
  const id = (req.body as { id?: unknown })?.id;
  // 폰이 id를 정해 보내면 하나만 넣고, 같은 id를 다시 보내도 늘지 않는다.
  if (typeof id === 'string') {
    const { item, created } = checklists.addWithId(GLOBAL_LIST, id, text);
    if (created) notifyTodo(L(`할 일 추가: ${item.text}`, `To-Do Added: ${item.text}`), '');
    res.status(created ? 201 : 200).json({ added: created ? [item] : [], items: checklists.list(GLOBAL_LIST) });
    return;
  }
  const added = checklists.addMany(GLOBAL_LIST, text);
  if (added.length > 0) {
    notifyTodo(
      added.length === 1
      ? L(`할 일 추가: ${added[0].text}`, `To-Do Added: ${added[0].text}`)
      : L(`할 일 ${added.length}건 추가`, `Added ${added.length} to-dos`),
      summarize(added),
    );
  }
  res.status(201).json({ added, items: checklists.list(GLOBAL_LIST) });
});

app.post('/checklist/clear-done', (_req, res) => {
  const removed = checklists.clearDone(GLOBAL_LIST);
  if (removed > 0) notifyTodo(L(`완료한 할 일 ${removed}건 정리`, `Cleared ${removed} completed to-do${removed === 1 ? '' : 's'}`), '');
  res.json({ removed, items: checklists.list(GLOBAL_LIST) });
});

/**
 * 순서 바꾸기. 알림은 남기지 않는다 — 내용이 바뀌지 않았고, 끌 때마다 쌓이면 시끄럽다.
 * 전역 목록과 세션 목록이 같이 쓴다.
 */
function reorderHandler(list: (req: Request) => string): express.RequestHandler {
  return (req, res) => {
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) {
      res.status(400).json({ error: { code: 'bad_ids', message: L('ids는 항목 id 배열이어야 합니다.', 'ids must be an array of item ids.') } });
      return;
    }
    const items = checklists.reorder(list(req), ids as string[]);
    res.json({ items });
  };
}

app.post('/checklist/order', reorderHandler(() => GLOBAL_LIST));

app.post('/checklist/:itemId/toggle', (req, res) => {
  // done을 주면 그 값으로 맞춘다. 뒤집기만 하면 오프라인에서 모아 둔 변경을
  // 다시 보낼 때 거꾸로 뒤집힐 수 있다.
  const done = (req.body as { done?: unknown })?.done;
  const item = checklists.toggle(GLOBAL_LIST, req.params.itemId, typeof done === 'boolean' ? done : undefined);
  if (!item) {
    res.status(404).json({ error: { code: 'item_not_found', message: L('없는 항목', 'No such item') } });
    return;
  }
  notifyTodo(
    item.done ? L(`할 일 완료: ${item.text}`, `To-Do Completed: ${item.text}`) : L(`할 일 되돌림: ${item.text}`, `To-Do Reopened: ${item.text}`), '');
  res.json({ item, items: checklists.list(GLOBAL_LIST) });
});

app.patch('/checklist/:itemId', (req, res) => {
  const text = String((req.body as { text?: unknown })?.text ?? '');
  if (!text.trim()) {
    res.status(400).json({ error: { code: 'empty_text', message: L('내용이 비었습니다.', 'The text is empty.') } });
    return;
  }
  // 바꾸기 전 내용을 알림 본문에 남긴다. 바뀐 뒤에는 알 수 없다.
  const before = checklists.list(GLOBAL_LIST).find((i) => i.id === req.params.itemId);
  const item = checklists.update(GLOBAL_LIST, req.params.itemId, text);
  if (!item) {
    res.status(404).json({ error: { code: 'item_not_found', message: L('없는 항목', 'No such item') } });
    return;
  }
  notifyTodo(L(`할 일 수정: ${item.text}`, `To-Do Edited: ${item.text}`), before ? L(`이전: ${before.text}`, `Previous: ${before.text}`) : '');
  res.json({ item });
});

app.delete('/checklist/:itemId', (req, res) => {
  // 지우기 전에 읽어둔다. 알림에 무엇을 지웠는지 남겨야 한다.
  const item = checklists.list(GLOBAL_LIST).find((i) => i.id === req.params.itemId);
  const removed = checklists.remove(GLOBAL_LIST, req.params.itemId);
  if (removed && item) notifyTodo(L(`할 일 삭제: ${item.text}`, `To-Do Deleted: ${item.text}`), '');
  res.status(removed ? 204 : 404).end();
});

/*
 * 미리 등록한 명령(스니펫).
 *
 * 안경은 입력이 탭·스크롤 네 가지뿐이라 명령을 적어 넣을 수 없다.
 * 웹에서 등록하고 안경에서는 골라 실행한다.
 *
 * 목록은 이 서버가 들고 실행은 terminal-agent가 한다. 맥이 꺼져 있어도
 * 목록은 남아야 켜고 나서 바로 고를 수 있다.
 *
 * 훅 키로는 손대지 못한다. 알림 훅과 정반대 성격이다 — 여기는 임의
 * 명령을 실행하는 문이라 로그인한 사람만 다뤄야 한다.
 */

app.get('/snippets', (_req, res) => {
  res.json({ items: snippets.list() });
});

app.post('/snippets', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  // 폰이 정한 id가 이미 있으면 그대로 돌려준다. 오프라인에서 만든 것을 다시 보내도 하나로 남는다.
  if (typeof b.id === 'string') {
    const existing = snippets.get(b.id);
    if (existing) {
      res.json({ item: existing, items: snippets.list() });
      return;
    }
  }
  const item = snippets.add({
    id: typeof b.id === 'string' ? b.id : undefined,
    label: typeof b.label === 'string' ? b.label : undefined,
    command: String(b.command ?? ''),
    dir: typeof b.dir === 'string' ? b.dir : undefined,
    kind: b.kind === 'cron' ? 'cron' : 'once',
    everyMinutes: typeof b.everyMinutes === 'number' ? b.everyMinutes : undefined,
    notifyOn:
      b.notifyOn === 'always' || b.notifyOn === 'never' || b.notifyOn === 'change'
        ? b.notifyOn
        : undefined,
  });
  res.status(201).json({ item, items: snippets.list() });
});

app.patch('/snippets/:id', (req, res) => {
  const item = snippets.update(req.params.id, (req.body ?? {}) as never);
  if (!item) {
    res.status(404).json({ error: { code: 'not_found', message: L('없는 명령입니다.', 'No such command.') } });
    return;
  }
  res.json({ item });
});

app.delete('/snippets/:id', (req, res) => {
  res.status(snippets.remove(req.params.id) ? 204 : 404).end();
});

/**
 * 등록한 명령을 실행한다.
 *
 * 실행 자체는 terminal-agent가 한다. 되돌릴 수 없어 보이는 명령은
 * 그쪽이 409로 막고, 사용자가 확인하면 confirm을 실어 다시 보낸다.
 */
app.post('/snippets/:id/run', async (req, res) => {
  const item = snippets.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: { code: 'not_found', message: L('없는 명령입니다.', 'No such command.') } });
    return;
  }

  const agent = termAgents.default();
  if (!agent) {
    res.status(503).json({
      error: { code: 'no_agent', message: L('연결된 terminal-agent가 없습니다. 맥에서 실행하세요.', 'No terminal-agent connected. Run it on the Mac.') },
    });
    return;
  }

  const confirm = (req.body as { confirm?: unknown })?.confirm === true;

  try {
    const reply = await agent.request(
      'POST',
      '/run',
      JSON.stringify({ command: item.command, dir: item.dir, confirm }),
    );

    // 성공했으면 결과를 적어 둔다. 예약 실행이 변화를 견주는 데 쓴다.
    if (reply.status === 200) {
      const parsed = JSON.parse(reply.body) as { output?: string; exitCode?: number };
      snippets.recordRun(item.id, parsed.output ?? '', parsed.exitCode ?? -1);
    }
    res.status(reply.status).type('application/json').send(reply.body);
  } catch (err) {
    res.status(502).json({ error: { code: 'agent_error', message: (err as Error).message } });
  }
});

// --- 알림 ---
//
// 완료·오류 알림을 쌓아둔다. 안경에서 한 번 놓쳐도 나중에 다시 볼 수 있다.
// 세션 라우트보다 먼저 와야 /notifications가 중계로 새지 않는다.

app.get('/notifications', (req, res) => {
  const items = notifications.list();
  const unreadOnly = String((req.query as { unread?: unknown })?.unread ?? '') === '1';
  res.json({
    items: unreadOnly ? items.filter((n) => !n.readAt) : items,
    unread: items.filter((n) => !n.readAt).length,
  });
});

app.post('/notifications', (req, res) => {
  const b = (req.body ?? {}) as {
    title?: unknown;
    body?: unknown;
    kind?: unknown;
    sessionId?: unknown;
  };
  const title = String(b.title ?? '');
  if (!title.trim()) {
    res.status(400).json({ error: { code: 'empty_title', message: L('알림 제목이 없습니다.', 'The notification has no title.') } });
    return;
  }
  const kind = String(b.kind ?? 'info');
  const item = notifications.add({
    title,
    body: b.body === undefined ? undefined : String(b.body),
    kind: (['done', 'error', 'permission', 'info'].includes(kind)
      ? kind
      : 'info') as NotificationKind,
    sessionId: b.sessionId === undefined ? undefined : String(b.sessionId),
  });
  res.status(201).json({ item, unread: notifications.unreadCount() });
});

app.post('/notifications/read-all', (_req, res) => {
  res.json({ changed: notifications.markAllRead(), unread: 0 });
});

app.post('/notifications/clear-read', (_req, res) => {
  const removed = notifications.clearRead();
  res.json({ removed, items: notifications.list(), unread: notifications.unreadCount() });
});

app.post('/notifications/:id/read', (req, res) => {
  const item = notifications.markRead(req.params.id);
  if (!item) {
    res.status(404).json({ error: { code: 'not_found', message: L('없는 알림', 'No such notification') } });
    return;
  }
  res.json({ item, unread: notifications.unreadCount() });
});

app.delete('/notifications/:id', (req, res) => {
  res.status(notifications.remove(req.params.id) ? 204 : 404).end();
});

// --- 체크리스트 (서버가 직접 관리한다) ---
//
// 중계하지 않고 여기서 처리하므로 맥이 꺼져 있어도 목록을 보고 고칠 수 있다.
// 라우트를 중계보다 먼저 등록해야 /sessions 중계로 새지 않는다.

app.get('/sessions/:id/checklist', (req, res) => {
  res.json({ items: checklists.list(req.params.id) });
});

/** 여러 줄을 보내면 줄마다 항목이 된다. */
app.post('/sessions/:id/checklist', (req, res) => {
  const text = String((req.body as { text?: unknown })?.text ?? '');
  if (!text.trim()) {
    res.status(400).json({ error: { code: 'empty_text', message: L('추가할 내용이 없습니다.', 'Nothing to add.') } });
    return;
  }
  const clientId = (req.body as { id?: unknown })?.id;
  if (typeof clientId === 'string') {
    const { item, created } = checklists.addWithId(req.params.id, clientId, text);
    if (created) notifyTodo(L(`할 일 추가: ${item.text}`, `To-Do Added: ${item.text}`), '', req.params.id);
    res.status(created ? 201 : 200).json({ added: created ? [item] : [], items: checklists.list(req.params.id) });
    return;
  }
  const added = checklists.addMany(req.params.id, text);
  if (added.length === 0) {
    res.status(400).json({ error: { code: 'empty_text', message: L('추가할 내용이 없습니다.', 'Nothing to add.') } });
    return;
  }
  notifyTodo(
    added.length === 1
      ? L(`할 일 추가: ${added[0].text}`, `To-Do Added: ${added[0].text}`)
      : L(`할 일 ${added.length}건 추가`, `Added ${added.length} to-dos`),
    summarize(added),
    req.params.id,
  );
  res.status(201).json({ added, items: checklists.list(req.params.id) });
});

app.post('/sessions/:id/checklist/clear-done', (req, res) => {
  const removed = checklists.clearDone(req.params.id);
  if (removed > 0) notifyTodo(L(`완료한 할 일 ${removed}건 정리`, `Cleared ${removed} completed to-do${removed === 1 ? '' : 's'}`), '', req.params.id);
  res.json({ removed, items: checklists.list(req.params.id) });
});

app.post('/sessions/:id/checklist/order', reorderHandler((req) => String(req.params.id)));
app.post('/sessions/:id/checklist/:itemId/toggle', (req, res) => {
  const done = (req.body as { done?: unknown })?.done;
  const item = checklists.toggle(
    req.params.id,
    req.params.itemId,
    typeof done === 'boolean' ? done : undefined,
  );
  if (!item) {
    res.status(404).json({ error: { code: 'item_not_found', message: L('없는 항목', 'No such item') } });
    return;
  }
  notifyTodo(
    item.done ? L(`할 일 완료: ${item.text}`, `To-Do Completed: ${item.text}`) : L(`할 일 되돌림: ${item.text}`, `To-Do Reopened: ${item.text}`), '', req.params.id);
  res.json({ item, items: checklists.list(req.params.id) });
});

app.patch('/sessions/:id/checklist/:itemId', (req, res) => {
  const text = String((req.body as { text?: unknown })?.text ?? '');
  if (!text.trim()) {
    res.status(400).json({ error: { code: 'empty_text', message: L('내용이 비었습니다.', 'The text is empty.') } });
    return;
  }
  const before = checklists.list(req.params.id).find((i) => i.id === req.params.itemId);
  const item = checklists.update(req.params.id, req.params.itemId, text);
  if (!item) {
    res.status(404).json({ error: { code: 'item_not_found', message: L('없는 항목', 'No such item') } });
    return;
  }
  notifyTodo(L(`할 일 수정: ${item.text}`, `To-Do Edited: ${item.text}`), before ? L(`이전: ${before.text}`, `Previous: ${before.text}`) : '', req.params.id);
  res.json({ item });
});

app.delete('/sessions/:id/checklist/:itemId', (req, res) => {
  const item = checklists.list(req.params.id).find((i) => i.id === req.params.itemId);
  const removed = checklists.remove(req.params.id, req.params.itemId);
  if (removed && item) notifyTodo(L(`할 일 삭제: ${item.text}`, `To-Do Deleted: ${item.text}`), '', req.params.id);
  res.status(removed ? 204 : 404).end();
});

// --- 중계 ---

/**
 * 요청을 agent로 넘기고 응답을 그대로 돌려준다.
 *
 * 어느 레지스트리를 쓸지 받는다. claudeAgent와 terminal-agent가
 * 각자 다른 목록에 있기 때문이다.
 */
async function forward(
  reg: AgentRegistry,
  label: string,
  req: Request,
  res: Response,
): Promise<void> {
  const agent = reg.default();
  if (!agent) {
    res.status(503).json({
      error: { code: 'no_agent', message: L(`연결된 ${label}가 없습니다. 맥에서 실행하세요.`, `No ${label} connected. Run it on the Mac.`) },
    });
    return;
  }

  try {
    const body = req.method === 'GET' || req.method === 'DELETE'
      ? undefined
      : JSON.stringify(req.body ?? {});
    const reply = await agent.request(req.method, req.originalUrl, body);
    res.status(reply.status).type('application/json').send(reply.body);
  } catch (err) {
    res.status(502).json({
      error: { code: 'agent_error', message: (err as Error).message },
    });
  }
}

/** SSE를 맥에서 받아 클라이언트로 흘려보낸다. */
function forwardStream(reg: AgentRegistry, req: Request, res: Response): void {
  const agent = reg.default();
  if (!agent) {
    res.status(503).end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const stop = agent.openStream(req.originalUrl, (chunk, done) => {
    if (chunk) res.write(chunk);
    if (done) res.end();
  });

  // 유휴 연결이 중간 장비에서 끊기지 않게 한다.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
  const cleanup = (): void => {
    clearInterval(keepAlive);
    stop();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

/**
 * 서버가 들고 있는 자료(체크리스트·알림)가 바뀌면 알려준다.
 *
 * 세션은 맥이 SSE로 흘려보내지만 이 둘은 서버가 직접 갖는다. 그래서
 * 여기서 따로 내보낸다. 웹에서 할 일을 더하면 안경도 곧바로 안다.
 *
 * 무엇이 바뀌었는지만 보낸다. 내용은 받는 쪽이 다시 읽는다.
 */
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // 붙자마자 한 번 보낸다. 받는 쪽이 첫 상태를 맞출 수 있다.
  res.write('event: hello\ndata: {}\n\n');

  const stop = subscribe((topic) => {
    res.write(`event: changed\ndata: ${JSON.stringify({ topic })}\n\n`);
  });

  // 누가 듣고 있는지 남긴다. 안경에 반영이 안 될 때 여기부터 본다 —
  // 붙지도 않았는지, 붙었는데 못 받는지가 갈린다.
  const who = String(req.headers['user-agent'] ?? '').slice(0, 40);
  console.log(`[relay] 변화 구독 +1 (${subscriberCount()}명) ${who}`);

  // 조용한 연결이 중간 장비에서 끊기지 않게 한다.
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);

  const cleanup = (): void => {
    clearInterval(ping);
    stop();
    console.log(`[relay] 변화 구독 -1 (${subscriberCount()}명)`);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

// 스트림이 먼저 잡혀야 일반 중계로 새지 않는다.
//
// 터미널 스트림을 앞에 둔다. 뒤에 두면 아래의 일반 /stream 규칙이
// 먼저 잡아 claudeAgent 쪽으로 새버린다.
app.get(/^\/terminals\b.*\/stream$/, (req, res) => forwardStream(termAgents, req, res));
app.get(/\/stream$/, (req, res) => forwardStream(agents, req, res));

app.all(/^\/terminals\b/, (req, res) => void forward(termAgents, 'terminal-agent', req, res));
// 시스템 상태(top·ps 요약)도 terminal-agent가 갖고 있다. 맥 안의
// 정보이므로 셸을 여는 쪽과 같은 agent에 둔다.
app.all(/^\/sys\b/, (req, res) => void forward(termAgents, 'terminal-agent', req, res));
// 한 번 실행하고 끝나는 명령. 스니펫 실행이 여기로 온다.
app.all(/^\/run\b/, (req, res) => void forward(termAgents, 'terminal-agent', req, res));
// /health는 agent-cli 쪽 것을 넘긴다. 웹이 여기서 allowedRoots를 받아
// 워크스페이스 추가 화면에 보여준다. 중계하지 않으면 404가 난다.
app.all(/^\/(sessions|workspaces|jobs|files|health)\b/, (req, res) => void forward(agents, 'agent-cli', req, res));

// --- 안경앱 서빙 ---

// 웹 관리 UI는 /web 에 둔다. 안경앱과 경로가 겹치지 않게 한다.
if (fs.existsSync(config.webRoot)) {
  app.use('/web', express.static(config.webRoot));
  // SPA 라우팅: /web 아래 GET은 index.html로 넘긴다.
  app.get(/^\/web(\/.*)?$/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(config.webRoot, 'index.html'));
  });
}

// 안경앱은 루트에 둔다. G2가 QR로 루트를 열기 때문이다.
if (fs.existsSync(config.glassesRoot)) {
  app.use(express.static(config.glassesRoot));
  app.get(/^(?!\/(relay|auth|sessions|workspaces|jobs|files|terminals|sys|run|snippets|health|web)\b).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(config.glassesRoot, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: L(`경로 없음: ${req.path}`, `No such path: ${req.path}`) } });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: { code: 'auth_error', message: err.message } });
    return;
  }
  if (err instanceof ChecklistError) {
    res.status(400).json({ error: { code: 'checklist_error', message: err.message } });
    return;
  }
  if (err instanceof SnippetError) {
    res.status(400).json({ error: { code: 'snippet_error', message: err.message } });
    return;
  }
  // 내부 오류 문구에는 경로나 내부 사정이 섞인다. 밖에는 알리지 않고 로그로 남긴다.
  console.error('[relay] 처리 중 오류:', err);
  res.status(500).json({ error: { code: 'internal_error', message: L('서버 오류가 났습니다.', 'Server error.') } });
});

// --- agent-cli 접속구 ---

const server = http.createServer(app);

/**
 * WebSocket 접속구가 둘이다.
 *
 * `new WebSocketServer({ server, path })`를 두 번 쓰면 안 된다. 각자
 * upgrade 리스너를 달고, 경로가 자기 것이 아니면 소켓을 파기해버려서
 * 뒤에 붙은 쪽은 요청을 보지도 못한다(400으로 끊긴다).
 *
 * 그래서 noServer로 만들고 upgrade를 여기서 직접 나눈다.
 */
const wss = new WebSocketServer({ noServer: true });
const termWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/agent') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  if (pathname === '/terminal-agent') {
    termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
    return;
  }

  socket.destroy();
});

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token') ?? '';
  const name = url.searchParams.get('name') || '이름 없는 agent';

  // 토큰이 없으면 받지 않는다. 받아주면 아무나 agent로 붙고, 먼저 붙은
  // 쪽을 쓰므로 진짜 agent가 끊긴 사이 모든 프롬프트가 그쪽으로 갔다.
  // terminal-agent 접속구와 같은 규칙이다.
  if (!config.agentToken) {
    logAuthFailure(req.socket.remoteAddress ?? 'unknown', '/agent');
    socket.close(1008, 'RELAY_AGENT_TOKEN이 설정되지 않았습니다.');
    return;
  }
  if (!safeEqual(token, config.agentToken)) {
    logAuthFailure(req.socket.remoteAddress ?? 'unknown', '/agent');
    socket.close(1008, '토큰이 올바르지 않습니다.');
    return;
  }

  const agent = agents.add(name, socket);
  console.log(`[relay] agent 접속: ${name} (${agent.id.slice(0, 8)})`);
  socket.send(JSON.stringify({ type: 'welcome', agentId: agent.id }));

  socket.on('close', () => console.log(`[relay] agent 끊김: ${name}`));
});

// --- terminal-agent 접속구 ---
//
// 셸을 여는 쪽이라 토큰을 따로 둔다. agent-cli 토큰이 새도
// 터미널까지 넘어가지는 않게 한다.
termWss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token') ?? '';
  const name = url.searchParams.get('name') || '이름 없는 terminal';

  if (!config.terminalToken) {
    // 토큰을 안 정했으면 아예 받지 않는다. 셸이 무인증으로 열리면 안 된다.
    logAuthFailure(req.socket.remoteAddress ?? 'unknown', '/terminal-agent');
    socket.close(1008, 'RELAY_TERMINAL_TOKEN이 설정되지 않았습니다.');
    return;
  }
  if (!safeEqual(token, config.terminalToken)) {
    logAuthFailure(req.socket.remoteAddress ?? 'unknown', '/terminal-agent');
    socket.close(1008, '토큰이 올바르지 않습니다.');
    return;
  }

  const agent = termAgents.add(name, socket);
  console.log(`[relay] terminal-agent 접속: ${name} (${agent.id.slice(0, 8)})`);
  socket.send(JSON.stringify({ type: 'welcome', agentId: agent.id }));

  socket.on('close', () => console.log(`[relay] terminal-agent 끊김: ${name}`));
});

server.listen(config.port, config.host, () => {
  console.log(`\n${BANNER}\n${' '.repeat(20)}${TAGLINE}\n`);
  console.log(`[relay] http://${config.host}:${config.port}`);
  console.log(`[relay] agent 접속구: ws://${config.host}:${config.port}/agent`);
  console.log(`[relay] 터미널 접속구: ws://${config.host}:${config.port}/terminal-agent`);
  console.log(`[relay] 안경앱 /     : ${fs.existsSync(config.glassesRoot) ? config.glassesRoot : '(없음)'}`);
  console.log(`[relay] 웹 UI  /web  : ${fs.existsSync(config.webRoot) ? config.webRoot : '(없음)'}`);
  for (const w of warnings()) console.warn(`[relay] 경고: ${w}`);
  // 계정이 없으면 서버가 잠겨 있다. 무엇을 해야 하는지 로그에서 바로 보이게 한다.
  if (!auth.isConfigured) console.log(`\n${firstRunGuide(auth.setupCode).map((l) => (l ? `[relay] ${l}` : '[relay]')).join('\n')}\n`);

  // 예약한 명령을 돌린다. 등록된 것이 없으면 아무 일도 하지 않는다.
  scheduler.start();
  const cron = snippets.list().filter((x) => x.kind === 'cron').length;
  if (cron > 0) console.log(`[relay] 예약 명령 ${cron}건을 주기마다 돌립니다.`);

  // 폰이 맥 IP가 바뀌어도 이 서버를 찾게 알린다(맥에서만).
  stopAdvertising = advertise(config.port);
  if (process.platform === 'darwin' && process.env.RELAY_BONJOUR !== 'false') {
    console.log(`[relay] 같은 와이파이에 알림: ${serviceName()}`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[relay] ${sig} 수신, 종료합니다.`);
    scheduler.stop();
    stopAdvertising();
    server.close(() => process.exit(0));
    // 실시간 연결(SSE·스트림)은 스스로 끝나지 않는다. close만 하면 안경·폰이
    // 붙어 있는 동안 종료가 멈춘 채 남고, 붙은 쪽은 서버가 살아 있다고 여긴다.
    server.closeAllConnections();
    // 웹소켓(agent)처럼 따로 떼어 간 연결이 남아도 오래 붙잡지 않는다.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
