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
import { config, warnings } from './core/config.js';
import { agents, AgentRegistry } from './core/agents.js';
import { termAgents } from './core/term-agents.js';
import { checklists, ChecklistError, GLOBAL_LIST } from './core/checklist.js';
import { notifications, type NotificationKind } from './core/notifications.js';
import { BANNER, TAGLINE } from './core/banner.js';
import { logAuthFailure, rateLimiter, safeEqual } from './core/security.js';
import { auth, AuthError } from './core/auth.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

// G2와 모바일 앱은 다른 오리진에서 붙는다. 인증은 키가 담당한다.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.header('origin') ?? '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

/** 중계 API만 인증한다. 정적 파일과 상태 확인은 열어둔다. */
function isProtected(p: string): boolean {
  // 계정 관리 중 로그인/설정/상태는 인증 없이 열어야 한다.
  if (/^\/auth\/(status|setup|login|logout)$/.test(p)) return false;
  // terminals를 빠뜨리면 셸이 무인증으로 열린다. 반드시 포함해야 한다.
  // health도 막는다 — 응답에 allowedRoots(서버 경로)가 들어 있다.
  return /^\/(sessions|workspaces|jobs|files|terminals|health|checklist|notifications|motd|auth)\b/.test(p);
}

app.use((req, res, next) => {
  if (!isProtected(req.path)) return next();

  const ip = req.ip ?? 'unknown';
  // 무차별 시도를 늦춘다.
  if (!rateLimiter.allow(ip)) {
    res.status(429).json({
      error: { code: 'rate_limited', message: '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.' },
    });
    return;
  }

  // 설정 전에는 잠가둔다. 키를 빠뜨린 채 인터넷에 열리는 사고를 막는다.
  if (!auth.isConfigured) {
    res.status(503).json({
      error: { code: 'setup_required', message: '초기 설정이 필요합니다. /setup 에서 계정을 만드세요.' },
    });
    return;
  }

  // EventSource는 헤더를 못 붙이므로 스트림 경로는 쿼리 토큰도 받는다.
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const provided =
    bearer ??
    req.header('x-api-key') ??
    (req.path.endsWith('/stream') ? (req.query.token as string | undefined) : undefined) ??
    (req.path.endsWith('/stream') ? (req.query.apiKey as string | undefined) : undefined);

  if (!provided) {
    logAuthFailure(ip, req.path);
    res.status(401).json({ error: { code: 'unauthorized', message: '로그인이 필요합니다.' } });
    return;
  }

  // 세션 토큰이 우선. 환경변수 키는 기존 클라이언트 호환용으로 남긴다.
  const ok =
    auth.verifyToken(provided) ||
    (config.clientKey.length > 0 && safeEqual(provided, config.clientKey));

  if (!ok) {
    logAuthFailure(ip, req.path);
    res.status(401).json({ error: { code: 'unauthorized', message: '인증에 실패했습니다.' } });
    return;
  }
  next();
});

// --- 계정 ---

/** 설정이 끝났는지. 클라이언트가 첫 화면을 정하는 데 쓴다. */
app.get('/auth/status', (_req, res) => {
  res.json({ configured: auth.isConfigured, username: auth.username });
});

/** 최초 관리자 계정을 만든다. 이미 있으면 409로 거부한다. */
app.post('/auth/setup', (req, res, next) => {
  const { username, password } = (req.body ?? {}) as Record<string, string>;
  auth
    .setup(String(username ?? ''), String(password ?? ''))
    .then((token) => res.status(201).json({ token, username }))
    .catch(next);
});

app.post('/auth/login', (req, res, next) => {
  const ip = req.ip ?? 'unknown';
  // 로그인은 특히 조심스럽게 센다.
  if (!rateLimiter.allow(`login:${ip}`)) {
    res.status(429).json({ error: { code: 'rate_limited', message: '잠시 후 다시 시도하세요.' } });
    return;
  }
  const { username, password, label } = (req.body ?? {}) as Record<string, string>;
  auth
    .login(String(username ?? ''), String(password ?? ''), String(label ?? '기기'))
    .then((token) => res.json({ token, username }))
    .catch((err) => {
      logAuthFailure(ip, '/auth/login');
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
    .then(() => res.json({ ok: true, message: '비밀번호를 바꿨습니다. 모든 기기가 로그아웃됩니다.' }))
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
    up < 60 ? `${up}초` : up < 3600 ? `${Math.floor(up / 60)}분` : `${Math.floor(up / 3600)}시간`;

  const unread = notifs.filter((n) => !n.readAt).length;
  const open = todos.filter((t) => !t.done).length;

  res.json({
    lines: [
      `relay-service · 가동 ${uptime}`,
      list.length > 0
        ? `agent ${list.length}대 연결됨 (${list.map((a) => a.name).join(', ')})`
        : 'agent 미연결 — 맥에서 agent-cli를 실행하세요',
      `알림 ${unread}건 · 할 일 ${open}건 남음`,
    ],

    agents: list.length,
    unread: notifs.filter((n) => !n.readAt).length,
    todos: todos.filter((t) => !t.done).length,
  });
});


// --- 전역 체크리스트 ---
//
// 세션과 무관하게 항상 보이는 공용 목록.
// 세션별 라우트와 같은 저장소를 쓰되 id만 고정한다.

app.get('/checklist', (_req, res) => {
  res.json({ items: checklists.list(GLOBAL_LIST) });
});

app.post('/checklist', (req, res) => {
  const text = String((req.body as { text?: unknown })?.text ?? '');
  if (!text.trim()) {
    res.status(400).json({ error: { code: 'empty_text', message: '추가할 내용이 없습니다.' } });
    return;
  }
  const added = checklists.addMany(GLOBAL_LIST, text);
  res.status(201).json({ added, items: checklists.list(GLOBAL_LIST) });
});

app.post('/checklist/clear-done', (_req, res) => {
  const removed = checklists.clearDone(GLOBAL_LIST);
  res.json({ removed, items: checklists.list(GLOBAL_LIST) });
});

app.post('/checklist/:itemId/toggle', (req, res) => {
  const item = checklists.toggle(GLOBAL_LIST, req.params.itemId);
  if (!item) {
    res.status(404).json({ error: { code: 'item_not_found', message: '없는 항목' } });
    return;
  }
  res.json({ item, items: checklists.list(GLOBAL_LIST) });
});

app.patch('/checklist/:itemId', (req, res) => {
  const text = String((req.body as { text?: unknown })?.text ?? '');
  if (!text.trim()) {
    res.status(400).json({ error: { code: 'empty_text', message: '내용이 비었습니다.' } });
    return;
  }
  const item = checklists.update(GLOBAL_LIST, req.params.itemId, text);
  if (!item) {
    res.status(404).json({ error: { code: 'item_not_found', message: '없는 항목' } });
    return;
  }
  res.json({ item });
});

app.delete('/checklist/:itemId', (req, res) => {
  res.status(checklists.remove(GLOBAL_LIST, req.params.itemId) ? 204 : 404).end();
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
    res.status(400).json({ error: { code: 'empty_title', message: '알림 제목이 없습니다.' } });
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
    res.status(404).json({ error: { code: 'not_found', message: '없는 알림' } });
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
    res.status(400).json({ error: { code: 'empty_text', message: '추가할 내용이 없습니다.' } });
    return;
  }
  const added = checklists.addMany(req.params.id, text);
  if (added.length === 0) {
    res.status(400).json({ error: { code: 'empty_text', message: '추가할 내용이 없습니다.' } });
    return;
  }
  res.status(201).json({ added, items: checklists.list(req.params.id) });
});

app.post('/sessions/:id/checklist/clear-done', (req, res) => {
  const removed = checklists.clearDone(req.params.id);
  res.json({ removed, items: checklists.list(req.params.id) });
});

app.post('/sessions/:id/checklist/:itemId/toggle', (req, res) => {
  const done = (req.body as { done?: unknown })?.done;
  const item = checklists.toggle(
    req.params.id,
    req.params.itemId,
    typeof done === 'boolean' ? done : undefined,
  );
  if (!item) {
    res.status(404).json({ error: { code: 'item_not_found', message: '없는 항목' } });
    return;
  }
  res.json({ item, items: checklists.list(req.params.id) });
});

app.patch('/sessions/:id/checklist/:itemId', (req, res) => {
  const text = String((req.body as { text?: unknown })?.text ?? '');
  if (!text.trim()) {
    res.status(400).json({ error: { code: 'empty_text', message: '내용이 비었습니다.' } });
    return;
  }
  const item = checklists.update(req.params.id, req.params.itemId, text);
  if (!item) {
    res.status(404).json({ error: { code: 'item_not_found', message: '없는 항목' } });
    return;
  }
  res.json({ item });
});

app.delete('/sessions/:id/checklist/:itemId', (req, res) => {
  res.status(checklists.remove(req.params.id, req.params.itemId) ? 204 : 404).end();
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
      error: { code: 'no_agent', message: `연결된 ${label}가 없습니다. 맥에서 실행하세요.` },
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

// 스트림이 먼저 잡혀야 일반 중계로 새지 않는다.
//
// 터미널 스트림을 앞에 둔다. 뒤에 두면 아래의 일반 /stream 규칙이
// 먼저 잡아 claudeAgent 쪽으로 새버린다.
app.get(/^\/terminals\b.*\/stream$/, (req, res) => forwardStream(termAgents, req, res));
app.get(/\/stream$/, (req, res) => forwardStream(agents, req, res));

app.all(/^\/terminals\b/, (req, res) => void forward(termAgents, 'terminal-agent', req, res));
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
  app.get(/^(?!\/(relay|auth|sessions|workspaces|jobs|files|terminals|health|web)\b).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(config.glassesRoot, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `경로 없음: ${req.path}` } });
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
  res.status(500).json({
    error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
  });
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

  if (config.agentToken && !safeEqual(token, config.agentToken)) {
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
  console.log(`[relay] 안경앱 /     : ${fs.existsSync(config.glassesRoot) ? config.glassesRoot : '(없음)'}`);
  console.log(`[relay] 웹 UI  /web  : ${fs.existsSync(config.webRoot) ? config.webRoot : '(없음)'}`);
  for (const w of warnings()) console.warn(`[relay] 경고: ${w}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[relay] ${sig} 수신, 종료합니다.`);
    server.close(() => process.exit(0));
  });
}
