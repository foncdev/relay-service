/**
 * 확장 에이전트 통로(/ext-agent, /ext) 검증.
 *
 * 실제 서버를 띄우고 가짜 mac-agent를 붙인다.
 *  - 토큰 없이, 이름이 이상하게 붙으면 받지 않는다
 *  - hello로 알린 기능 목록이 GET /ext에 그대로 나온다
 *  - /ext/<이름>/나머지가 에이전트에 /나머지로 넘어가고 응답이 돌아온다
 *  - 로그인 없이는 /ext를 볼 수 없다
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

const EXT_TOKEN = 'e'.repeat(48);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** 서버를 띄우고 계정을 만들어 로그인 토큰까지 받아 둔다. */
async function startServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ext-'));
  let log = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      RELAY_DATA_DIR: dir,
      RELAY_AGENT_TOKEN: '',
      RELAY_TERMINAL_TOKEN: '',
      RELAY_EXT_TOKEN: EXT_TOKEN,
      RELAY_CLIENT_KEY: '',
      RELAY_HOOK_KEY: '',
      RELAY_GLASSES_ROOT: path.join(dir, 'none'),
      RELAY_BONJOUR: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => (log += b));
  child.stderr.on('data', (b) => (log += b));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/auth/status`)).ok && /설정 코드/.test(log)) break;
    } catch {
      // 아직 안 떴다.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const code = /설정 코드: ([A-Z2-9-]+)/.exec(log)?.[1] ?? '';
  const setup = await fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'owner-pass-123456', code }),
  });
  const { token } = (await setup.json()) as { token: string };
  return {
    base,
    port,
    token,
    get: (p: string) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } }),
    stop: () => {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 접속해서 서버가 보내는 첫 메시지(또는 끊긴 사유)를 받는다. */
function connect(port: number, query: string): Promise<{ ws: WebSocket; first: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext-agent?${query}`);
    ws.once('message', (d) => resolve({ ws, first: d.toString() }));
    ws.once('close', (_code, reason) => resolve({ ws, first: `closed:${reason.toString()}` }));
  });
}

/** 가짜 mac-agent. 받은 요청을 그대로 되돌려 준다. */
function echoAgent(ws: WebSocket): void {
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString()) as { type: string; id: string; method: string; path: string; body?: string };
    if (msg.type !== 'request') return;
    ws.send(JSON.stringify({
      type: 'response',
      id: msg.id,
      status: 200,
      body: JSON.stringify({ method: msg.method, path: msg.path, body: msg.body ? JSON.parse(msg.body) : null }),
    }));
  });
}

test('토큰과 이름이 맞아야 붙는다', async () => {
  const s = await startServer();
  try {
    const bad = await connect(s.port, 'agent=mac-agent&token=wrong');
    assert.match(bad.first, /^closed:/);

    const badName = await connect(s.port, `agent=Mac_Agent!&token=${EXT_TOKEN}`);
    assert.match(badName.first, /^closed:/);

    const ok = await connect(s.port, `agent=mac-agent&name=test-mac&token=${EXT_TOKEN}`);
    const welcome = JSON.parse(ok.first) as { type: string; protocol: number };
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.protocol, 1, 'welcome에 서버 규약 버전이 실린다');
    ok.ws.close();
  } finally {
    s.stop();
  }
});

test('hello로 알린 기능 목록이 GET /ext에 나온다', async () => {
  const s = await startServer();
  try {
    const { ws } = await connect(s.port, `agent=mac-agent&name=test-mac&protocol=1&token=${EXT_TOKEN}`);
    ws.send(JSON.stringify({
      type: 'hello',
      version: '1.0.0',
      capabilities: [
        { id: 'present', ready: true },
        { id: 'captions', ready: false, reason: 'license_required' },
        { id: '../bad id', ready: true },
      ],
    }));
    await new Promise((r) => setTimeout(r, 100));

    const body = (await (await s.get('/ext')).json()) as {
      protocol: number;
      agents: { agent: string; name: string; version: string; capabilities: unknown[] }[];
    };
    assert.equal(body.protocol, 1);
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].agent, 'mac-agent');
    assert.equal(body.agents[0].name, 'test-mac');
    assert.equal(body.agents[0].version, '1.0.0');
    assert.deepEqual(body.agents[0].capabilities, [
      { id: 'present', ready: true },
      { id: 'captions', ready: false, reason: 'license_required' },
    ], '이상한 id는 버린다');

    // 권한을 켜거나 라이선스를 등록하면 목록을 다시 보낸다.
    ws.send(JSON.stringify({ type: 'capabilities', capabilities: [{ id: 'captions', ready: true }] }));
    await new Promise((r) => setTimeout(r, 100));
    const after = (await (await s.get('/ext')).json()) as { agents: { capabilities: unknown[] }[] };
    assert.deepEqual(after.agents[0].capabilities, [{ id: 'captions', ready: true }]);

    // 끊기면 목록에서 빠진다.
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const gone = (await (await s.get('/ext')).json()) as { agents: unknown[] };
    assert.equal(gone.agents.length, 0);
  } finally {
    s.stop();
  }
});

test('/ext/<이름>/나머지는 에이전트에 /나머지로 넘어간다', async () => {
  const s = await startServer();
  try {
    const { ws } = await connect(s.port, `agent=mac-agent&name=test-mac&token=${EXT_TOKEN}`);
    echoAgent(ws);

    const got = (await (await s.get('/ext/mac-agent/present/state?x=1')).json()) as { method: string; path: string };
    assert.deepEqual(got, { method: 'GET', path: '/present/state?x=1', body: null });

    const posted = await fetch(`${s.base}/ext/mac-agent/present/next`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 1 }),
    });
    assert.deepEqual(await posted.json(), { method: 'POST', path: '/present/next', body: { step: 1 } });

    // 붙지 않은 에이전트는 503.
    const none = await s.get('/ext/other-agent/anything');
    assert.equal(none.status, 503);
    ws.close();
  } finally {
    s.stop();
  }
});

test('로그인 없이는 /ext를 볼 수 없다', async () => {
  const s = await startServer();
  try {
    assert.equal((await fetch(`${s.base}/ext`)).status, 401);
    assert.equal((await fetch(`${s.base}/ext/mac-agent/present/next`, { method: 'POST' })).status, 401);
  } finally {
    s.stop();
  }
});

test('/ext/<이름>/…/stream은 claudeAgent가 아니라 그 에이전트로 흐른다', async () => {
  const s = await startServer();
  try {
    const { ws } = await connect(s.port, `agent=mac-agent&name=test-mac&token=${EXT_TOKEN}`);
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString()) as { type: string; id: string; path: string };
      if (msg.type !== 'stream_open') return;
      ws.send(JSON.stringify({ type: 'stream_chunk', id: msg.id, chunk: `data: ${msg.path}\n\n`, done: true }));
    });

    const res = await s.get('/ext/mac-agent/captions/stream');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /data: \/captions\/stream/);
    ws.close();
  } finally {
    s.stop();
  }
});

/** notify를 보내고 notify_ack를 기다린다. */
function notify(ws: WebSocket, ref: string, title: string, body = ''): Promise<{ ok: boolean; id?: string }> {
  return new Promise((resolve) => {
    const onMessage = (d: Buffer) => {
      const msg = JSON.parse(d.toString()) as { type: string; ref: string; ok: boolean; id?: string };
      if (msg.type !== 'notify_ack' || msg.ref !== ref) return;
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'notify', ref, title, body, kind: 'done' }));
  });
}

test('에이전트가 남긴 알림이 알림 목록에 들어가고 ack를 받는다', async () => {
  const s = await startServer();
  try {
    const { ws } = await connect(s.port, `agent=mac-agent&name=test-mac&token=${EXT_TOKEN}`);
    const ack = await notify(ws, 'r1', '회의 요약', '출시일 11월 3일 확정');
    assert.equal(ack.ok, true);
    assert.ok(ack.id);

    const list = (await (await s.get('/notifications')).json()) as { items: { id: string; title: string; body: string; kind: string }[] };
    const item = list.items.find((n) => n.id === ack.id);
    assert.equal(item?.title, '회의 요약');
    assert.equal(item?.kind, 'done');
    assert.match(item?.body ?? '', /출시일 11월 3일 확정\n\n— mac-agent$/, '어디서 왔는지 본문 끝에 붙는다');

    // 제목이 없으면 넣지 않지만 ack는 준다 — 에이전트가 끝없이 다시 보내지 않게.
    assert.equal((await notify(ws, 'r2', '  ')).ok, false);
    ws.close();
  } finally {
    s.stop();
  }
});

test('에이전트 하나가 알림을 쏟아내면 분당 20건에서 끊는다', async () => {
  const s = await startServer();
  try {
    const { ws } = await connect(s.port, `agent=mac-agent&name=test-mac&token=${EXT_TOKEN}`);
    const acks = [];
    for (let i = 0; i < 22; i++) acks.push(await notify(ws, `n${i}`, `알림 ${i}`));
    assert.equal(acks.filter((a) => a.ok).length, 20);
    assert.equal(acks[20].ok, false);
    ws.close();
  } finally {
    s.stop();
  }
});

/** checklist 요청을 보내고 답을 기다린다. */
function checklist(ws: WebSocket, ref: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (d: Buffer) => {
      const msg = JSON.parse(d.toString()) as { type: string; ref: string };
      if (msg.type !== 'checklist_reply' || msg.ref !== ref) return;
      ws.off('message', onMessage);
      resolve(msg as unknown as Record<string, unknown>);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'checklist', ref, ...body }));
  });
}

test('에이전트가 전역 체크리스트를 다루고, 할 일마다 알림을 남기지 않는다', async () => {
  const s = await startServer();
  try {
    const { ws } = await connect(s.port, `agent=mac-agent&name=test-mac&token=${EXT_TOKEN}`);
    const added = await checklist(ws, 'a', { op: 'add', id: 'reminder-0001', text: '우유 사기' });
    assert.equal(added.ok, true);
    // 같은 id로 다시 넣어도 하나다(동기화가 끊겼다 다시 보내도).
    await checklist(ws, 'a2', { op: 'add', id: 'reminder-0001', text: '우유 사기' });
    await checklist(ws, 'b', { op: 'toggle', itemId: 'reminder-0001', done: true });
    await checklist(ws, 'c', { op: 'update', itemId: 'reminder-0001', text: '두유 사기' });

    const list = (await checklist(ws, 'd', { op: 'list' })) as { items: { id: string; text: string; done: boolean }[] };
    assert.deepEqual(list.items.map((i) => [i.id, i.text, i.done]), [['reminder-0001', '두유 사기', true]]);

    // 웹에서 보는 목록도 같다.
    const web = (await (await s.get('/checklist')).json()) as { items: { id: string }[] };
    assert.deepEqual(web.items.map((i) => i.id), ['reminder-0001']);

    const notes = (await (await s.get('/notifications')).json()) as { items: unknown[] };
    assert.equal(notes.items.length, 0, '동기화로 바뀐 것은 알림을 남기지 않는다');

    assert.equal((await checklist(ws, 'e', { op: 'remove', itemId: 'reminder-0001' })).ok, true);
    assert.equal((await checklist(ws, 'f', { op: 'remove', itemId: 'reminder-0001' })).ok, false);
    assert.equal((await checklist(ws, 'g', { op: 'nope' })).ok, false);
    ws.close();
  } finally {
    s.stop();
  }
});

test('체크리스트가 바뀌면 확장 에이전트에 changed를 보낸다', async () => {
  const s = await startServer();
  try {
    const { ws } = await connect(s.port, `agent=mac-agent&name=test-mac&token=${EXT_TOKEN}`);
    const changed = new Promise<string>((resolve) => {
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString()) as { type: string; topic?: string };
        if (msg.type === 'changed') resolve(msg.topic ?? '');
      });
    });
    // 웹에서 할 일을 더한다.
    await fetch(`${s.base}/checklist`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '웹에서 넣은 일' }),
    });
    assert.equal(await changed, 'checklist');
    ws.close();
  } finally {
    s.stop();
  }
});
