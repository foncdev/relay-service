/** 매니저 REST API 클라이언트. */

export interface Workspace {
  id: string;
  path: string;
  description?: string;
  createdAt: string;
}

export type SessionStatus = 'starting' | 'idle' | 'busy' | 'waiting' | 'closed';

export interface PendingPermission {
  id: string;
  toolName: string;
  input: unknown;
  summary: string;
  reason: string;
  at: string;
}

/**
 * 세션 하나.
 *
 * 목록(GET /sessions)과 상세(GET /sessions/:id)의 모양이 다르다. 목록은
 * 가벼운 것만 담아 보내고, 아래 물음표가 붙은 필드는 아예 빠진다.
 * 필수로 적어두면 컴파일러가 통과시켜 버려서 실행 중에 터진다.
 */
export interface SessionInfo {
  id: string;
  workspaceId: string;
  cwd: string;
  title?: string;
  status: SessionStatus;
  claudeSessionId?: string;
  createdAt: string;
  lastActivityAt: string;
  turns: number;
  totalCostUsd: number;
  /** 프로세스가 살아있는지. 보관된 이력만 남은 세션은 false. */
  live: boolean;

  // --- 아래는 상세에만 있다. 목록에서는 없다고 보고 써야 한다. ---

  policyMode?: PolicyMode;
  /** 대기 중인 권한 요청. */
  pending?: PendingPermission[];
  memory?: Array<{ scope: string; path: string }>;
}

export type PolicyMode = 'ask-risky' | 'ask-all' | 'auto-approve';

export interface SessionEvent {
  type: string;
  sessionId: string;
  at: string;
  [key: string]: unknown;
}

/** 서버가 쌓아두는 알림. 안경·폰·웹이 같은 목록을 본다. */
export interface Notification {
  id: string;
  title: string;
  body: string;
  kind: 'done' | 'error' | 'permission' | 'info';
  sessionId?: string;
  createdAt: string;
  readAt?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modifiedAt: string;
}

/** terminal-agent가 들고 있는 터미널 하나. */
export interface TerminalInfo {
  id: string;
  dir: string;
  shell: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  pid: number;
  exitCode?: number;
  createdAt: string;
  lastActiveAt: string;
}

const KEY_STORAGE = 'agent-cli.apiKey';
const TOKEN_STORAGE = 'agent-cli.token';

/**
 * 로그인 토큰.
 *
 * 서버가 개인 인증으로 바뀌어 이 값이 주 자격증명이다.
 * 기존 API 키는 예전 설정과의 호환을 위해 남겨둔다.
 */
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE, token);
    else localStorage.removeItem(TOKEN_STORAGE);
  } catch {
    // 저장 못 해도 이번 세션에는 동작한다.
  }
}

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

const RESUME_PREF = 'agent-cli.deleteOriginalOnResume';

/** 이어가기 후 원본을 지울지. 되돌릴 수 없으므로 기본은 꺼짐. */
export function getDeleteOriginalOnResume(): boolean {
  try {
    return localStorage.getItem(RESUME_PREF) === '1';
  } catch {
    return false;
  }
}

export function setDeleteOriginalOnResume(on: boolean): void {
  try {
    if (on) localStorage.setItem(RESUME_PREF, '1');
    else localStorage.removeItem(RESUME_PREF);
  } catch {
    // 저장 실패는 무시한다. 기본값(꺼짐)으로 동작한다.
  }
}

export function setApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // 시크릿 모드 등에서는 저장을 포기하고 넘어간다.
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const key = getApiKey();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      // 토큰이 있으면 그걸 쓰고, 없으면 예전 키로 물러선다.
      ...(token ? { Authorization: `Bearer ${token}` } : key ? { 'x-api-key': key } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: string } }).error;
    throw new ApiError(err?.message ?? `요청 실패 (${res.status})`, err?.code ?? 'unknown', res.status);
  }
  return body as T;
}

const json = (data: unknown): RequestInit => ({ body: JSON.stringify(data) });

export interface AuthStatus {
  configured: boolean;
  username: string;
}

export const api = {
  // --- 인증 ---
  authStatus: () => request<AuthStatus>('/auth/status'),
  setup: (username: string, password: string) =>
    request<{ token: string; username: string }>('/auth/setup', {
      method: 'POST',
      ...json({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<{ token: string; username: string }>('/auth/login', {
      method: 'POST',
      ...json({ username, password, label: '웹' }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  changePassword: (current: string, next: string) =>
    request<{ ok: boolean; message: string }>('/auth/password', {
      method: 'POST',
      ...json({ current, next }),
    }),

  health: () => request<{ ok: boolean; allowedRoots: string[] }>('/health'),

  // --- 워크스페이스 ---
  listWorkspaces: () => request<{ workspaces: Workspace[] }>('/workspaces'),
  createWorkspace: (input: { id: string; path: string; description?: string }) =>
    request<{ workspace: Workspace }>('/workspaces', { method: 'POST', ...json(input) }),
  deleteWorkspace: (id: string) =>
    request<void>(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- 세션 ---
  listSessions: () => request<{ sessions: SessionInfo[] }>('/sessions'),
  createSession: (input: {
    workspaceId?: string;
    /** 절대 경로. 주면 워크스페이스를 자동 등록한다. */
    path?: string;
    model?: string;
    policyMode?: PolicyMode;
    subPath?: string;
  }) => request<{ session: SessionInfo }>('/sessions', { method: 'POST', ...json(input) }),
  getSession: (id: string) => request<{ session: SessionInfo }>(`/sessions/${id}`),
  sendInput: (id: string, prompt: string) =>
    request<{ session: SessionInfo }>(`/sessions/${id}/input`, {
      method: 'POST',
      ...json({ prompt }),
    }),
  renameSession: (id: string, title: string) =>
    request<{ session: SessionInfo }>(`/sessions/${id}`, { method: 'PATCH', ...json({ title }) }),
  /**
   * 종료된 세션의 대화를 이어간다. 새 세션이 만들어져 돌아온다.
   * deleteOriginal을 주면 이어간 뒤 원본 기록을 지운다 (되돌릴 수 없음).
   */
  resumeSession: (id: string, deleteOriginal = false) =>
    request<{ session: SessionInfo; deletedOriginal: boolean }>(`/sessions/${id}/resume`, {
      method: 'POST',
      ...json({ deleteOriginal }),
    }),
  closeSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  deleteSession: (id: string) => request<void>(`/sessions/${id}/history`, { method: 'DELETE' }),
  getHistory: (id: string) =>
    request<{ events: SessionEvent[] }>(`/sessions/${id}/history`),
  resolvePermission: (id: string, requestId: string, behavior: 'allow' | 'deny') =>
    request<{ session: SessionInfo }>(`/sessions/${id}/permissions`, {
      method: 'POST',
      ...json({ requestId, behavior }),
    }),
  setPolicy: (id: string, policyMode: PolicyMode) =>
    request<{ session: SessionInfo }>(`/sessions/${id}/policy`, {
      method: 'POST',
      ...json({ policyMode }),
    }),

  // --- 전역 체크리스트 (세션과 무관) ---
  /** 접속 직후 띄우는 서버 상태 요약. */
  getMotd: () => request<{ lines: string[] }>('/motd'),

  // --- 알림 ---
  getNotifications: () => request<{ items: Notification[]; unread: number }>('/notifications'),
  addNotification: (input: {
    title: string;
    body?: string;
    kind?: Notification['kind'];
    sessionId?: string;
  }) =>
    request<{ item: Notification; unread: number }>('/notifications', {
      method: 'POST',
      ...json(input),
    }),
  readNotification: (id: string) =>
    request<{ unread: number }>(`/notifications/${id}/read`, { method: 'POST', ...json({}) }),
  readAllNotifications: () =>
    request<{ changed: number }>('/notifications/read-all', { method: 'POST', ...json({}) }),
  clearReadNotifications: () =>
    request<{ removed: number; items: Notification[]; unread: number }>(
      '/notifications/clear-read',
      { method: 'POST', ...json({}) },
    ),
  deleteNotification: (id: string) =>
    request<void>(`/notifications/${id}`, { method: 'DELETE' }),

  getGlobalChecklist: () => request<{ items: ChecklistItem[] }>('/checklist'),
  addGlobalChecklist: (text: string) =>
    request<{ items: ChecklistItem[] }>('/checklist', { method: 'POST', ...json({ text }) }),
  toggleGlobalChecklist: (itemId: string) =>
    request<{ items: ChecklistItem[] }>(`/checklist/${itemId}/toggle`, {
      method: 'POST',
      ...json({}),
    }),
  updateGlobalChecklist: (itemId: string, text: string) =>
    request<{ item: ChecklistItem }>(`/checklist/${itemId}`, { method: 'PATCH', ...json({ text }) }),
  deleteGlobalChecklist: (itemId: string) =>
    request<void>(`/checklist/${itemId}`, { method: 'DELETE' }),
  clearDoneGlobalChecklist: () =>
    request<{ removed: number; items: ChecklistItem[] }>('/checklist/clear-done', {
      method: 'POST',
      ...json({}),
    }),

  // --- 세션별 체크리스트 ---
  getChecklist: (id: string) =>
    request<{ items: ChecklistItem[] }>(`/sessions/${id}/checklist`),
  /** 여러 줄을 보내면 줄마다 항목이 된다. */
  addChecklist: (id: string, text: string) =>
    request<{ items: ChecklistItem[] }>(`/sessions/${id}/checklist`, {
      method: 'POST',
      ...json({ text }),
    }),
  toggleChecklist: (id: string, itemId: string) =>
    request<{ items: ChecklistItem[] }>(`/sessions/${id}/checklist/${itemId}/toggle`, {
      method: 'POST',
      ...json({}),
    }),
  updateChecklist: (id: string, itemId: string, text: string) =>
    request<{ item: ChecklistItem }>(`/sessions/${id}/checklist/${itemId}`, {
      method: 'PATCH',
      ...json({ text }),
    }),
  deleteChecklist: (id: string, itemId: string) =>
    request<void>(`/sessions/${id}/checklist/${itemId}`, { method: 'DELETE' }),
  clearDoneChecklist: (id: string) =>
    request<{ removed: number; items: ChecklistItem[] }>(
      `/sessions/${id}/checklist/clear-done`,
      { method: 'POST', ...json({}) },
    ),

  // --- 파일 ---
  listFiles: (wsId: string, path = '', hidden = false) =>
    request<{ path: string; entries: FileEntry[] }>(
      `/workspaces/${encodeURIComponent(wsId)}/files?path=${encodeURIComponent(path)}&hidden=${hidden}`,
    ),
  readFile: (wsId: string, path: string) =>
    request<{ file: { path: string; content: string; size: number; modifiedAt: string } }>(
      `/workspaces/${encodeURIComponent(wsId)}/file?path=${encodeURIComponent(path)}`,
    ),
  writeFile: (wsId: string, path: string, content: string) =>
    request<{ file: { path: string; size: number } }>(
      `/workspaces/${encodeURIComponent(wsId)}/file`,
      { method: 'PUT', ...json({ path, content }) },
    ),
  mkdir: (wsId: string, path: string) =>
    request<{ path: string }>(`/workspaces/${encodeURIComponent(wsId)}/mkdir`, {
      method: 'POST',
      ...json({ path }),
    }),
  renameFile: (wsId: string, from: string, to: string) =>
    request<{ path: string }>(`/workspaces/${encodeURIComponent(wsId)}/rename`, {
      method: 'POST',
      ...json({ from, to }),
    }),
  deleteFile: (wsId: string, path: string, recursive = false) =>
    request<void>(
      `/workspaces/${encodeURIComponent(wsId)}/file?path=${encodeURIComponent(path)}&recursive=${recursive}`,
      { method: 'DELETE' },
    ),
  downloadUrl: (wsId: string, path: string) =>
    `/workspaces/${encodeURIComponent(wsId)}/download?path=${encodeURIComponent(path)}`,

  // --- 터미널 (terminal-agent) ---
  //
  // 세션과 달리 relay-service가 terminal-agent로 넘긴다.
  // 맥에서 도는 콘솔 화면과 같은 셸을 본다.

  listTerminals: () => request<{ terminals: TerminalInfo[] }>('/terminals'),

  createTerminal: (body: { dir?: string; cols: number; rows: number }) =>
    request<{ terminal: TerminalInfo }>('/terminals', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  closeTerminal: (id: string) =>
    request<void>(`/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * 창 크기를 알린다.
   *
   * 뷰어가 여럿이면 서버가 가장 작은 쪽에 맞추므로, 돌아오는 cols/rows가
   * 요청한 값과 다를 수 있다. 화면은 그 값에 맞춰야 한다.
   */
  resizeTerminal: (id: string, cols: number, rows: number) =>
    request<{ ok: boolean; cols: number; rows: number }>(`/terminals/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }),

  sendTerminalInput: (id: string, data: string) =>
    request<{ ok: boolean }>(`/terminals/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),
};

/** 세션 SSE 스트림에 붙는다. 반환값을 호출하면 끊는다. */
export function streamSession(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
  onError?: () => void,
): () => void {
  // EventSource는 헤더를 못 붙이므로 쿼리로 넘긴다.
  const token = getToken();
  const key = getApiKey();
  const auth = token
    ? `?token=${encodeURIComponent(token)}`
    : key
      ? `?apiKey=${encodeURIComponent(key)}`
      : '';
  const url = `/sessions/${sessionId}/stream${auth}`;
  const es = new EventSource(url);

  // 서버가 event: <type> 으로 보내므로 타입별로 받아야 한다.
  const types = [
    'status',
    'session',
    'user',
    'assistant',
    'thinking',
    'tool_use',
    'tool_result',
    'permission_request',
    'permission_resolved',
    'turn_complete',
    'stderr',
    'closed',
  ];
  for (const type of types) {
    es.addEventListener(type, (e) => {
      try {
        onEvent(JSON.parse((e as MessageEvent).data) as SessionEvent);
      } catch {
        // 파싱 실패한 프레임은 버린다.
      }
    });
  }
  es.onerror = () => onError?.();

  return () => es.close();
}

/** 스트림 경로에 붙일 인증 쿼리. EventSource와 WebSocket은 헤더를 못 쓴다. */
function streamAuthQuery(): string {
  const token = getToken();
  if (token) return `token=${encodeURIComponent(token)}`;
  const key = getApiKey();
  return key ? `apiKey=${encodeURIComponent(key)}` : '';
}

/**
 * 터미널 출력을 구독한다.
 *
 * 출력은 base64로 온다 — PTY가 뱉는 임의 바이트를 JSON에 실으려면
 * 그래야 한다. UTF-8 문자 중간에서 잘린 조각도 그대로 와야
 * 클라이언트가 이어 붙여 복원할 수 있다.
 *
 * 디코딩은 하지 않고 바이트로 넘긴다. 이어 붙이는 일은 xterm이 한다.
 */
export function streamTerminal(
  id: string,
  onData: (bytes: Uint8Array) => void,
  handlers?: { onExit?: (code: number) => void; onError?: () => void },
): () => void {
  const auth = streamAuthQuery();
  const url = `/terminals/${encodeURIComponent(id)}/stream${auth ? `?${auth}` : ''}`;
  const es = new EventSource(url);

  es.addEventListener('output', (e) => {
    onData(base64ToBytes((e as MessageEvent<string>).data));
  });

  es.addEventListener('exit', (e) => {
    try {
      const { code } = JSON.parse((e as MessageEvent<string>).data) as { code: number };
      handlers?.onExit?.(code);
    } catch {
      handlers?.onExit?.(0);
    }
    es.close();
  });

  es.onerror = () => handlers?.onError?.();

  return () => es.close();
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
