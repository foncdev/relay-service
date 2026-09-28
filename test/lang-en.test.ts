/**
 * RELAY_LANG=en이면 서버가 만드는 글(할 일 알림·motd·오류)이 영어인지 검증.
 *
 * 영어 할 일 알림 제목은 폰 앱(iOS·Android)의 영어 문구와 글자까지 같아야
 * 한다. 폰은 자기가 한 일을 제목으로 가려내 배너를 거르기 때문이다. 글자가
 * 다르면 폰에서 한 일마다 배너가 한 번 더 뜬다.
 *
 * todo-notify.test.ts처럼 서버를 따로 띄워 HTTP로 두드린다.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PORT = 4189;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess;
let token = '';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-en-'));
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RELAY_LANG: 'en',
      RELAY_DATA_DIR: dir,
      RELAY_CLIENT_KEY: 'k',
      RELAY_AGENT_TOKEN: 't',
      RELAY_TERMINAL_TOKEN: 't',
      RELAY_BONJOUR: 'false',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // 시작 로그(운영자용)는 한국어 그대로다.
  let log = '';
  proc.stdout!.on('data', (b) => (log += b));
  await waitUp();
  for (let i = 0; i < 50 && !/설정 코드: \S+/.test(log); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const code = /설정 코드: (\S+)/.exec(log)?.[1] ?? '';
  const res = await fetch(`${BASE}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'test-pass-1234', code }),
  });
  token = ((await res.json()) as { token: string }).token;
});

test.after(() => {
  proc?.kill();
  proc?.stdout?.destroy();
});

function api(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function notices(): Promise<{ title: string; body: string }[]> {
  return ((await (await api('/notifications')).json()) as { items: { title: string; body: string }[] }).items;
}

async function addTodo(text: string): Promise<string> {
  const { added } = (await (await api('/checklist', { method: 'POST', body: JSON.stringify({ text }) })).json()) as {
    added: { id: string }[];
  };
  return added[0].id;
}

test('할 일 알림 제목이 폰 앱의 영어 문구와 같다', async () => {
  const id = await addTodo('Buy milk');
  await api(`/checklist/${id}`, { method: 'PATCH', body: JSON.stringify({ text: 'Buy oat milk' }) });
  await api(`/checklist/${id}/toggle`, { method: 'POST' });
  await api(`/checklist/${id}/toggle`, { method: 'POST' });
  const other = await addTodo('Wash dishes');
  await api(`/checklist/${other}`, { method: 'DELETE' });

  const list = await notices();
  const titles = list.map((n) => n.title);
  for (const t of [
    'To-Do Added: Buy milk',
    'To-Do Edited: Buy oat milk',
    'To-Do Completed: Buy oat milk',
    'To-Do Reopened: Buy oat milk',
    'To-Do Deleted: Wash dishes',
  ]) {
    assert.ok(titles.includes(t), `${t} 없음: ${titles.join(' | ')}`);
  }
  assert.equal(list.find((n) => n.title === 'To-Do Edited: Buy oat milk')?.body, 'Previous: Buy milk');
});

test('완료한 할 일 정리와 여러 개 추가도 영어다', async () => {
  const id = await addTodo('Done soon');
  await api(`/checklist/${id}/toggle`, { method: 'POST' });
  await api('/checklist/clear-done', { method: 'POST' });
  await api('/checklist', { method: 'POST', body: JSON.stringify({ text: 'a\nb' }) });

  const titles = (await notices()).map((n) => n.title);
  assert.ok(titles.some((t) => /^Cleared \d+ completed to-dos?$/.test(t)), titles.join(' | '));
  assert.ok(titles.includes('Added 2 to-dos'), titles.join(' | '));
});

test('motd와 오류 문구도 영어다', async () => {
  const motd = (await (await api('/motd')).json()) as { lines: string[] };
  assert.match(motd.lines[0], /^relay-service · up \d+[smh]$/);
  assert.match(motd.lines[1], /No agent connected/);
  assert.match(motd.lines[2], /unread · \d+ to-dos? left$/);

  const empty = (await (await api('/checklist', { method: 'POST', body: JSON.stringify({ text: '' }) })).json()) as {
    error: { message: string };
  };
  assert.equal(empty.error.message, 'Nothing to add.');
});
