/**
 * 폰의 오프라인 동기화를 받쳐 주는 서버 동작 검증.
 *
 * 폰은 오프라인에서 한 변경을 모아 두었다가 다시 붙으면 차례로 보낸다.
 * 보내다 끊기면 같은 요청을 또 보내게 되므로 두 번 받아도 결과가 같아야
 * 한다(할 일·명령 추가는 폰이 정한 id로 하나만 남는다). 완료는 뒤집기가
 * 아니라 값을 정해서 보낸다 — 뒤집기를 다시 보내면 거꾸로 된다.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PORT = 4189;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-sync-'));
  // npx를 거치지 않고 서버를 직접 띄운다. npx로 띄우면 kill이 npx만
  // 끝내고 서버(자식)는 살아남아 stdout 파이프를 붙잡는다. 그러면 리눅스
  // CI에서 테스트 프로세스가 파이프가 닫히기를 기다리며 끝나지 않았다.
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RELAY_DATA_DIR: dir,
      RELAY_CLIENT_KEY: 'k',
      RELAY_AGENT_TOKEN: 't',
      RELAY_TERMINAL_TOKEN: 't',
      // 테스트 서버를 같은 와이파이에 알리지 않는다. 폰이 진짜 서버로 착각한다.
      RELAY_BONJOUR: 'false',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // 초기 설정에는 시작 로그에 찍히는 설정 코드가 필요하다.
  let log = '';
  proc.stdout!.on('data', (b) => (log += b));
  await waitUp();
  for (let i = 0; i < 50 && !/설정 코드: \S+/.test(log); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const code = /설정 코드: (\S+)/.exec(log)?.[1] ?? '';

  // 새 데이터 폴더라 계정이 없다. 만들지 않으면 전부 503이다.
  const res = await fetch(`${BASE}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS, code }),
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

async function todos(): Promise<{ id: string; text: string; done: boolean }[]> {
  return ((await (await api('/checklist')).json()) as { items: { id: string; text: string; done: boolean }[] }).items;
}

test('할 일: 폰이 정한 id로 두 번 보내도 하나만 생기고 알림도 한 번', async () => {
  const id = randomUUID();
  const send = () => api('/checklist', { method: 'POST', body: JSON.stringify({ id, text: '오프라인에서 적은 일' }) });
  const first = await send();
  const second = await send();
  assert.equal(first.status, 201);
  assert.equal(second.status, 200, '두 번째는 새로 만들지 않는다');
  assert.equal((await todos()).filter((t) => t.id === id).length, 1);
  const { items } = (await (await api('/notifications')).json()) as { items: { title: string }[] };
  assert.equal(items.filter((n) => n.title === '할 일 추가: 오프라인에서 적은 일').length, 1, '알림이 두 번 남았다');
});

test('할 일: id를 주면 여러 줄도 한 항목이다', async () => {
  const id = randomUUID();
  await api('/checklist', { method: 'POST', body: JSON.stringify({ id, text: '첫 줄\n둘째 줄' }) });
  assert.equal((await todos()).find((t) => t.id === id)?.text, '첫 줄 둘째 줄');
});

test('할 일: 모양이 이상한 id는 받지 않는다', async () => {
  const res = await api('/checklist', { method: 'POST', body: JSON.stringify({ id: '../x', text: '나쁜 id' }) });
  assert.equal(res.status, 400);
});

test('할 일: 완료를 값으로 정하면 다시 보내도 그대로다', async () => {
  const id = randomUUID();
  await api('/checklist', { method: 'POST', body: JSON.stringify({ id, text: '체크할 일' }) });
  const set = (done: boolean) => api(`/checklist/${id}/toggle`, { method: 'POST', body: JSON.stringify({ done }) });
  await set(true);
  await set(true);
  assert.equal((await todos()).find((t) => t.id === id)?.done, true, '두 번 보내서 되돌아갔다');
  await set(false);
  assert.equal((await todos()).find((t) => t.id === id)?.done, false);
  // 값을 안 주면 예전처럼 뒤집는다(안경·웹).
  await api(`/checklist/${id}/toggle`, { method: 'POST' });
  assert.equal((await todos()).find((t) => t.id === id)?.done, true);
});

test('할 일: 순서를 바꾸면 목록이 그 순서다', async () => {
  const ids = [randomUUID(), randomUUID()];
  for (const [n, id] of ids.entries()) {
    await api('/checklist', { method: 'POST', body: JSON.stringify({ id, text: `순서 ${n}` }) });
  }
  const res = await api('/checklist/order', { method: 'POST', body: JSON.stringify({ ids: [ids[1], ids[0]] }) });
  assert.equal(res.status, 200);
  const order = (await todos()).map((t) => t.id).filter((i) => ids.includes(i));
  assert.deepEqual(order, [ids[1], ids[0]]);

  const bad = await api('/checklist/order', { method: 'POST', body: JSON.stringify({ ids: 'x' }) });
  assert.equal(bad.status, 400);
});

test('명령: 폰이 정한 id로 두 번 보내도 하나만 생긴다', async () => {
  const id = randomUUID();
  const send = () => api('/snippets', { method: 'POST', body: JSON.stringify({ id, label: '디스크', command: 'df -h' }) });
  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 200);
  const { items } = (await (await api('/snippets')).json()) as { items: { id: string }[] };
  assert.equal(items.filter((s) => s.id === id).length, 1);
});

test('끌 때 실시간 연결이 열려 있어도 곧 끝난다', async () => {
  // 열린 SSE를 기다리면 종료가 멈추고, 폰은 서버가 살아 있다고 여긴다.
  const ac = new AbortController();
  const res = await fetch(`${BASE}/events?token=${encodeURIComponent(token)}`, { signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read();

  const exited = new Promise<number>((resolve) => proc.once('exit', () => resolve(Date.now())));
  const start = Date.now();
  proc.kill('SIGTERM');
  const end = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 5000))]);
  ac.abort();
  assert.ok(end > 0, '5초가 지나도 서버가 끝나지 않았다');
  assert.ok(end - start < 4000, `${end - start}ms 걸렸다`);
});
