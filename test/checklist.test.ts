/**
 * 할 일 입력 처리 검증.
 *
 * 목록 기호를 떼는 정규식이 숫자를 통째로 먹은 적이 있다. "555"를 넣으면
 * 빈 문자열이 되어 조용히 사라졌고, 서버는 201을 돌려줘서 화면만 안 바뀐
 * 것처럼 보였다. 찾는 데 오래 걸린 버그라 여기 박아 둔다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Checklists } from '../src/core/checklist.js';

/** 테스트마다 빈 폴더를 준다. 서로 간섭하지 않는다. */
function fresh(): Checklists {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-'));
  return new Checklists(dir);
}

test('숫자만 적은 할 일도 들어간다', () => {
  const c = fresh();
  const added = c.addMany('s', '555');

  assert.equal(added.length, 1, '숫자가 사라졌다');
  assert.equal(added[0]!.text, '555');
});

test('여러 자리 숫자도 그대로 남는다', () => {
  const c = fresh();
  for (const n of ['1', '42', '2026', '0']) {
    const added = c.addMany('s', n);
    assert.equal(added[0]?.text, n, `${n}이(가) 바뀌었다`);
  }
});

test('목록 기호는 떼어낸다', () => {
  const c = fresh();
  const cases: [string, string][] = [
    ['- 우유 사기', '우유 사기'],
    ['* 빨래', '빨래'],
    ['1. 첫째', '첫째'],
    ['2) 둘째', '둘째'],
    ['3] 셋째', '셋째'],
  ];
  for (const [input, want] of cases) {
    const added = c.addMany('s', input);
    assert.equal(added[0]?.text, want, `${input} 처리가 틀렸다`);
  }
});

test('숫자 뒤에 기호가 없으면 번호로 보지 않는다', () => {
  const c = fresh();
  // 이것이 지워지던 버그의 핵심이다. "3 번째 줄"의 3은 기호가 아니다.
  assert.equal(c.addMany('s', '3 번째 줄')[0]?.text, '3 번째 줄');
  assert.equal(c.addMany('s', '2026년 계획')[0]?.text, '2026년 계획');
});

test('여러 줄은 줄마다 항목이 된다', () => {
  const c = fresh();
  const added = c.addMany('s', '첫째\n555\n- 셋째');

  assert.deepEqual(
    added.map((i) => i.text),
    ['첫째', '555', '셋째'],
  );
});

test('빈 줄은 건너뛴다', () => {
  const c = fresh();
  const added = c.addMany('s', '하나\n\n  \n둘');

  assert.deepEqual(
    added.map((i) => i.text),
    ['하나', '둘'],
  );
});
