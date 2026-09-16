/**
 * 외부 알림 훅의 몸통 해석 검증.
 *
 * 보내는 쪽을 고칠 수 있으면 {title, body}로 주면 된다. 그러나 남의
 * 서비스는 자기 형식으로만 보내고 바꿀 방법이 없다. 그래서 흔한 이름을
 * 훑고, 하나도 못 찾으면 몸통을 그대로 보여준다 — 알림이 통째로
 * 사라지는 것보다 무엇이 왔는지 보이는 편이 낫다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toNotification } from '../src/core/hook.js';

test('title과 body를 그대로 쓴다', () => {
  const n = toNotification({ title: '배포 완료', body: 'v1.2.3' });
  assert.equal(n?.title, '배포 완료');
  assert.equal(n?.body, 'v1.2.3');
  assert.equal(n?.kind, 'info');
});

test('흔한 다른 이름도 제목으로 받는다', () => {
  // 서비스마다 부르는 이름이 다르다. 고칠 수 없는 쪽을 위한 것이다.
  assert.equal(toNotification({ text: '슬랙식' })?.title, '슬랙식');
  assert.equal(toNotification({ message: '메시지식' })?.title, '메시지식');
  assert.equal(toNotification({ subject: '메일식' })?.title, '메일식');
});

test('문자열 한 줄만 보내도 받는다', () => {
  const n = toNotification('서버가 죽었습니다');
  assert.equal(n?.title, '서버가 죽었습니다');
});

test('심각도를 알림 종류로 옮긴다', () => {
  // 오류를 info로 흘리면 안경에서 갈래가 뭉개진다.
  assert.equal(toNotification({ title: 'a', level: 'error' })?.kind, 'error');
  assert.equal(toNotification({ title: 'a', severity: 'critical' })?.kind, 'error');
  assert.equal(toNotification({ title: 'a', status: 'failed' })?.kind, 'error');
  assert.equal(toNotification({ title: 'a', status: 'success' })?.kind, 'done');
  assert.equal(toNotification({ title: 'a', level: 'warning' })?.kind, 'info');
});

test('아는 이름이 없으면 몸통을 그대로 보여준다', () => {
  // 남의 형식이라 고칠 수 없다. 버리는 대신 사용자가 판단하게 한다.
  const n = toNotification({ zzz: '알 수 없는 형식', count: 3 });
  assert.ok(n, '통째로 버렸다 — 무엇이 왔는지 알 수 없다');
  assert.ok(n.body.includes('알 수 없는 형식'), '몸통이 본문에 없다');
});

test('제목만 있으면 남은 값으로 본문을 채운다', () => {
  const n = toNotification({ title: '빌드', branch: 'main', build: 42 });
  assert.match(n?.body ?? '', /branch: main/);
  assert.match(n?.body ?? '', /build: 42/);
});

test('0과 false도 제목이 될 수 있다', () => {
  // 참거짓 검사로 걸러내면 이 값들이 사라진다.
  assert.equal(toNotification({ title: 0 })?.title, '0');
  assert.equal(toNotification({ title: false })?.title, 'false');
});

test('빈 몸통은 받지 않는다', () => {
  // 빈 알림을 쌓으면 목록만 지저분해지고 알려주는 것이 없다.
  assert.equal(toNotification({}), undefined);
  assert.equal(toNotification(''), undefined);
  assert.equal(toNotification(null), undefined);
  assert.equal(toNotification([1, 2]), undefined);
});

test('제목이 너무 길면 자른다', () => {
  const n = toNotification({ title: 'ㄱ'.repeat(500) });
  assert.ok((n?.title.length ?? 0) <= 200, '상한을 넘겼다');
});

test('보낸 곳 이름을 실어 보낸다', () => {
  const n = toNotification({ title: '알림' }, 'github');
  assert.equal(n?.source, 'github');
});
