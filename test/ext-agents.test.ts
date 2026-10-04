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
