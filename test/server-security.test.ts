/**
 * 실제 서버를 띄워 인터넷에 열리는 표면을 검증한다.
 *
 * 따로 띄운 인스턴스에서 재현한 문제들이다.
 *  - 틀린 비밀번호 40번이 한 번도 막히지 않았다(로그인 한도가 일반 요청과 같은 300)
 *  - 토큰 없이 붙은 가짜 agent가 welcome을 받았다
 *  - 관리 화면을 다른 사이트 프레임에 넣을 수 있었다
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** 서버를 띄우고, 시작 로그에서 설정 코드를 읽어 둔다. */
async function startServer(env: Record<string, string> = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sec-'));
  let log = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      RELAY_DATA_DIR: dir,
      RELAY_AGENT_TOKEN: '',
      RELAY_TERMINAL_TOKEN: '',
      RELAY_CLIENT_KEY: '',
      RELAY_HOOK_KEY: '',
      RELAY_GLASSES_ROOT: path.join(dir, 'none'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (b) => (log += b));
  child.stderr!.on('data', (b) => (log += b));
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
  return {
    base,
    port,
    code,
    stop: () => {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('시작 로그의 설정 코드로만 계정을 만든다', async () => {
  const s = await startServer();
  try {
    assert.match(s.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, '처음 실행 안내에 코드가 찍힌다');
    const noCode = await post(`${s.base}/auth/setup`, { username: 'owner', password: 'owner-pass-123456' });
    assert.equal(noCode.status, 403);
    const ok = await post(`${s.base}/auth/setup`, { username: 'owner', password: 'owner-pass-123456', code: s.code });
    assert.equal(ok.status, 201);
  } finally {
    s.stop();
  }
});

test('로그인은 IP당 분당 10번까지만 받는다', async () => {
  const s = await startServer();
  try {
    await post(`${s.base}/auth/setup`, { username: 'owner', password: 'owner-pass-123456', code: s.code });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await post(`${s.base}/auth/login`, { username: 'owner', password: 'wrong-password-1' })).status);
    }
    // 설정도 같은 한도를 쓴다(1번). 로그인 9번이 401, 그다음부터 429.
    assert.equal(codes.filter((c) => c === 401).length, 9, codes.join(' '));
    assert.equal(codes.at(-1), 429);
  } finally {
    s.stop();
  }
});

test('보안 헤더를 붙인다', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/auth/status`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    s.stop();
  }
});

/** WebSocket으로 붙어 첫 메시지나 닫힘 사유를 돌려준다. */
function probeAgent(port: number, token: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?name=probe&token=${encodeURIComponent(token)}`);
    ws.on('message', (m) => {
      resolve(JSON.parse(String(m)).type);
      ws.close();
    });
    ws.on('close', (code) => resolve(`closed ${code}`));
    ws.on('error', () => resolve('error'));
  });
}

test('agent 토큰이 비어 있으면 아무도 agent로 붙지 못한다', async () => {
  const s = await startServer();
  try {
    assert.equal(await probeAgent(s.port, ''), 'closed 1008');
  } finally {
    s.stop();
  }
});

test('agent 토큰이 있으면 맞는 토큰만 붙는다', async () => {
  const token = 'a'.repeat(48);
  const s = await startServer({ RELAY_AGENT_TOKEN: token });
  try {
    assert.equal(await probeAgent(s.port, token), 'welcome');
    assert.equal(await probeAgent(s.port, 'wrong'), 'closed 1008');
  } finally {
    s.stop();
  }
});

test('24자보다 짧은 클라이언트 키는 받지 않는다', async () => {
  const s = await startServer({ RELAY_CLIENT_KEY: 'short-key-14ch' });
  try {
    await post(`${s.base}/auth/setup`, { username: 'owner', password: 'owner-pass-123456', code: s.code });
    const res = await fetch(`${s.base}/checklist`, { headers: { 'x-api-key': 'short-key-14ch' } });
    assert.equal(res.status, 401);
  } finally {
    s.stop();
  }
});
