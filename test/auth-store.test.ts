/**
 * 계정 저장소 보안 검증.
 *
 *  - 초기 설정은 시작 로그의 설정 코드가 있어야 한다. 계정이 없는 동안
 *    /auth/setup은 인터넷의 누구에게나 열려 있다.
 *  - 동시에 두 번 설정하면 하나만 된다. 예전에는 둘 다 201을 받고 나중
 *    것이 계정을 덮어썼으며, 두 쪽 모두 관리자 토큰을 들고 있었다.
 *  - 토큰은 해시로만 저장한다. auth.json이 새도 그대로 로그인되지 않게.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
process.env.RELAY_DATA_DIR = dir;

const { AuthStore, AuthError } = await import('../src/core/auth.js');
const FILE = path.join(dir, 'auth.json');

function fresh() {
  fs.rmSync(FILE, { force: true });
  return new AuthStore();
}

test('설정 코드 없이는 계정을 만들 수 없다', async () => {
  const store = fresh();
  assert.match(store.setupCode ?? '', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await assert.rejects(store.setup('owner', 'owner-pass-123456', ''), (e) => e instanceof AuthError && e.status === 403);
  await assert.rejects(store.setup('owner', 'owner-pass-123456', 'AAAA-BBBB-CCCC'), AuthError);
  assert.equal(store.isConfigured, false);
});

test('코드는 대소문자와 -를 가리지 않고, 쓰고 나면 사라진다', async () => {
  const store = fresh();
  const code = store.setupCode!.toLowerCase().replace(/-/g, ' ');
  await store.setup('owner', 'owner-pass-123456', code);
  assert.equal(store.isConfigured, true);
  assert.equal(store.setupCode, undefined);
});

test('동시에 두 번 설정하면 하나만 된다', async () => {
  const store = fresh();
  const code = store.setupCode!;
  const results = await Promise.allSettled([
    store.setup('owner', 'owner-pass-123456', code),
    store.setup('attacker', 'attacker-pass-9876', code),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(store.username, 'owner', '먼저 온 설정이 남는다');
});

test('토큰은 원문 없이 해시로만 저장한다', async () => {
  const store = fresh();
  const token = await store.setup('owner', 'owner-pass-123456', store.setupCode!);
  const raw = fs.readFileSync(FILE, 'utf8');
  assert.equal(raw.includes(token), false, '파일에 토큰 원문이 없다');
  assert.equal(store.verifyToken(token), true);
  assert.equal(store.verifyToken(`${token}x`), false);

  store.revoke(token);
  assert.equal(store.verifyToken(token), false);
});

test('원문으로 저장된 예전 토큰은 읽을 때 해시로 옮기고 그대로 쓴다', () => {
  const legacy = 'legacy-token-value-000000000000000000000';
  fs.writeFileSync(
    FILE,
    JSON.stringify({
      account: { username: 'owner', password: 'x:y', createdAt: '' },
      tokens: [{ token: legacy, label: '예전', createdAt: '', expiresAt: '2999-01-01T00:00:00Z' }],
    }),
  );
  const store = new AuthStore();
  assert.equal(store.verifyToken(legacy), true);
  assert.equal(fs.readFileSync(FILE, 'utf8').includes(legacy), false);
});
