/**
 * 할 일을 바꾸면 알림이 남는지 검증.
 *
 * 웹에서 할 일을 고쳐도 안경은 홈 요약의 숫자만 달라져서, 무엇이
 * 바뀌었는지 알 수 없었다. 추가·수정·완료·삭제가 모두 알림으로
 * 남아야 나중에 목록에서 되짚을 수 있다.
 *
 * SSE도 함께 본다. 할 일 변경은 알림까지 바꾸므로 두 topic이 모두
 * 나가야 한다. checklist만 보내면 목록은 바뀌고 배지는 그대로다.
 *
 * 라우트는 index.ts에 있고 이 파일은 불러오는 즉시 포트를 잡는다.
 * 그래서 프로세스를 따로 띄워 HTTP로 두드린다.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PORT = 4188;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'tester';
const PASS = 'test-pass-1234';

let proc: ChildProcess;
let token = '';

/** 서버가 응답할 때까지 기다린다. 뜨기 전에 두드리면 연결이 거부된다. */
async function waitUp(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${BASE}/auth/status`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('서버가 뜨지 않았습니다.');
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-notify-'));
  proc = spawn('npx', ['tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RELAY_DATA_DIR: dir,
      RELAY_CLIENT_KEY: 'k',
      RELAY_AGENT_TOKEN: 't',
      RELAY_TERMINAL_TOKEN: 't',
    },
    stdio: 'ignore',
  });
  await waitUp();

  // 새 데이터 폴더라 계정이 없다. 만들지 않으면 전부 503이다.
  const res = await fetch(`${BASE}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  token = ((await res.json()) as { token: string }).token;
});

test.after(() => proc?.kill());

function api(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function titles(): Promise<string[]> {
  const { items } = (await (await api('/notifications')).json()) as {
    items: { title: string }[];
  };
  return items.map((n) => n.title);
}

/** 할 일 하나를 새로 만들고 id를 준다. */
async function addTodo(text: string): Promise<string> {
  const { added } = (await (
    await api('/checklist', { method: 'POST', body: JSON.stringify({ text }) })
  ).json()) as { added: { id: string }[] };
  return added[0].id;
}

test('할 일을 추가하면 알림이 남는다', async () => {
  await addTodo('우유 사기');
  assert.ok(
    (await titles()).includes('할 일 추가: 우유 사기'),
    '추가 알림이 없다',
  );
});

test('할 일을 수정하면 이전 내용까지 알림에 남는다', async () => {
  const id = await addTodo('빵 사기');
  await api(`/checklist/${id}`, { method: 'PATCH', body: JSON.stringify({ text: '떡 사기' }) });

  const { items } = (await (await api('/notifications')).json()) as {
    items: { title: string; body: string }[];
  };
  const n = items.find((x) => x.title === '할 일 수정: 떡 사기');
  assert.ok(n, '수정 알림이 없다');
  assert.match(n.body, /빵 사기/, '무엇이 바뀌었는지 알 수 없다');
});

test('할 일을 완료하면 알림이 남는다', async () => {
  const id = await addTodo('청소하기');
  await api(`/checklist/${id}/toggle`, { method: 'POST' });
  assert.ok((await titles()).includes('할 일 완료: 청소하기'), '완료 알림이 없다');

  // 되돌리면 되돌렸다고 남아야 한다. 둘이 같으면 목록이 헷갈린다.
  await api(`/checklist/${id}/toggle`, { method: 'POST' });
  assert.ok((await titles()).includes('할 일 되돌림: 청소하기'), '되돌림 알림이 없다');
});

test('할 일을 지우면 무엇을 지웠는지 알림에 남는다', async () => {
  const id = await addTodo('설거지');
  const res = await api(`/checklist/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.ok(
    (await titles()).includes('할 일 삭제: 설거지'),
    '지운 내용이 남지 않으면 되짚을 수 없다',
  );
});

test('없는 할 일을 지우면 알림을 남기지 않는다', async () => {
  const before = (await titles()).length;
  const res = await api('/checklist/00000000-0000-4000-8000-000000000000', { method: 'DELETE' });
  assert.equal(res.status, 404);
  assert.equal((await titles()).length, before, '실패한 요청이 알림을 남겼다');
});

test('할 일 변경은 checklist와 notifications를 모두 알린다', async () => {
  // 배지는 notifications를 보고 갱신한다. 하나만 나가면 안경에서
  // 목록은 바뀌고 배지는 그대로다.
  const ac = new AbortController();
  const res = await fetch(`${BASE}/events?token=${encodeURIComponent(token)}`, {
    signal: ac.signal,
  });
  const reader = res.body!.getReader();

  const seen: string[] = [];
  const pump = (async () => {
    const dec = new TextDecoder();
    while (seen.length < 2) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const m of dec.decode(value).matchAll(/"topic":"(\w+)"/g)) seen.push(m[1]);
    }
  })();

  await addTodo('SSE 확인');
  await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);
  ac.abort();

  assert.ok(seen.includes('checklist'), 'checklist 알림이 없다');
  assert.ok(seen.includes('notifications'), 'notifications 알림이 없다 — 배지가 안 바뀐다');
});
