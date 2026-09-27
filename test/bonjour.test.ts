/**
 * 같은 와이파이의 폰이 서버를 찾게 알리는지 검증.
 *
 * 맥 IP가 바뀌면 폰에 적어 둔 주소가 틀렸다. 이름으로 알려 두면 폰이 새
 * IP를 찾는다. 맥이 아닌 곳(도커·리눅스)에서는 알리지 않는다.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { advertise, serviceName, SERVICE_TYPE } from '../src/core/bonjour.js';

test('맥이 아니면 알리지 않는다', () => {
  const stop = advertise(4100, { platform: 'linux' });
  assert.equal(typeof stop, 'function');
  stop();
});

test('꺼 두면 알리지 않는다', () => {
  advertise(4100, { enabled: false, platform: 'darwin' })();
});

test('이름에 맥 이름이 들어간다', () => {
  assert.match(serviceName(), /^relay-service \(.+\)$/);
  assert.equal(SERVICE_TYPE, '_relay._tcp');
});

test('맥에서는 dns-sd로 알리고 멈추면 사라진다', { skip: process.platform !== 'darwin' }, async () => {
  const port = 45123;
  const stop = advertise(port, { enabled: true });
  // dns-sd -B로 찾아본다. 알린 뒤 등록까지 잠깐 걸린다.
  const found = await new Promise<string>((resolve) => {
    const browse = spawn('dns-sd', ['-B', SERVICE_TYPE, 'local'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    browse.stdout.on('data', (b) => (out += b));
    setTimeout(() => {
      browse.kill();
      resolve(out);
    }, 2500);
  });
  stop();
  assert.ok(found.includes(serviceName().slice(0, 20)), `찾지 못했다:\n${found}`);
});
