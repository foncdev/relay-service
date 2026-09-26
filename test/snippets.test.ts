/**
 * 등록해 두는 명령의 저장 검증.
 *
 * 안경은 입력이 탭·스크롤 네 가지뿐이라 명령을 적어 넣을 수 없다.
 * 웹에서 등록하고 안경에서는 골라 실행한다. 목록은 이 서버가 들어
 * 맥이 꺼져 있어도 남는다.
 *
 * 저장 위치는 모듈을 읽는 시점에 정해진다. import보다 먼저
 * RELAY_DATA_DIR을 임시 폴더로 돌려 실제 데이터를 건드리지 않게 한다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.RELAY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-test-'));

const { snippets, SnippetError } = await import('../src/core/snippets.js');

test.beforeEach(() => {
  for (const s of snippets.list()) snippets.remove(s.id);
});

test('명령을 등록하고 읽는다', () => {
  const item = snippets.add({ label: '디스크', command: 'df -h /' });
  assert.equal(item.label, '디스크');
  assert.equal(item.command, 'df -h /');
  assert.equal(item.kind, 'once');
  assert.equal(snippets.list().length, 1);
});

test('이름을 안 주면 명령을 이름으로 쓴다', () => {
  // 목록에 빈 줄이 생기면 안경에서 고를 수 없다.
  const item = snippets.add({ command: 'git status' });
  assert.equal(item.label, 'git status');
});

test('빈 명령은 받지 않는다', () => {
  assert.throws(() => snippets.add({ command: '   ' }), SnippetError);
});

test('예약은 주기를 범위 안으로 맞춘다', () => {
  // 1분보다 촘촘하면 맥에 부담이고 알림이 쏟아진다.
  const fast = snippets.add({ command: 'x', kind: 'cron', everyMinutes: 0 });
  assert.equal(fast.everyMinutes, 1);

  const slow = snippets.add({ command: 'y', kind: 'cron', everyMinutes: 99999 });
  assert.equal(slow.everyMinutes, 1440, '하루를 넘기면 예약의 뜻이 없다');
});

test('예약 기본은 변화가 있을 때만 알린다', () => {
  // 매 주기 "정상"을 띄우면 알림이 쌓이기만 한다.
  const item = snippets.add({ command: 'x', kind: 'cron' });
  assert.equal(item.notifyOn, 'change');
});

test('once로 되돌리면 예약 값이 사라진다', () => {
  // 남겨두면 다시 cron으로 바꿀 때 옛 주기가 조용히 되살아난다.
  const item = snippets.add({ command: 'x', kind: 'cron', everyMinutes: 30 });
  const back = snippets.update(item.id, { kind: 'once' });
  assert.equal(back?.everyMinutes, undefined);
  assert.equal(back?.notifyOn, undefined);
});

test('실행 결과를 적어 둔다', () => {
  // 다음 실행과 견줘 변화를 본다.
  const item = snippets.add({ command: 'echo hi' });
  snippets.recordRun(item.id, 'hi\n', 0);

  const after = snippets.get(item.id);
  assert.equal(after?.lastOutput, 'hi\n');
  assert.equal(after?.lastExitCode, 0);
  assert.ok(after?.lastRunAt, '실행 시각이 없으면 주기를 셀 수 없다');
});

test('없는 것을 고치거나 지우면 알려준다', () => {
  assert.equal(snippets.update('nope', { label: 'x' }), undefined);
  assert.equal(snippets.remove('nope'), false);
});

test('긴 이름과 명령을 자른다', () => {
  const item = snippets.add({ label: 'ㄱ'.repeat(200), command: 'a'.repeat(5000) });
  assert.ok(item.label.length <= 40, `이름 상한 초과: ${item.label.length}`);
  assert.ok(item.command.length <= 2000, `명령 상한 초과: ${item.command.length}`);
});
