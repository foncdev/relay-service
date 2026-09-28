/**
 * 관리 UI(web/src/i18n.ts)의 한국어·영어 판 검증.
 *
 * DOM 없이 node에서 불러온다. i18n.ts는 navigator·document가 없으면
 * 건드리지 않으므로 여기서도 읽힌다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOGS, LOCALES, detectLocale, formatRelative, msg, setLocale } from '../web/src/i18n.ts';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

/** 판의 값을 글로 펼친다. 함수는 그럴듯한 인자로 불러 본다. */
function render(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'function') {
    // 인자 모양이 제각각이라 숫자·글·참거짓을 섞어 넣는다.
    const args = Array.from({ length: value.length }, (_, i) => (i === 0 ? 2 : 'x'));
    return [String(value(...args)), String(value(1, 'x')), String(value(true, 'x'))];
  }
  return [String(value)];
}

test('ko와 en의 키가 같다', () => {
  const ko = Object.keys(CATALOGS.ko).sort();
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(CATALOGS[l]).sort(), ko, `${l} 판의 키가 한국어 판과 다릅니다.`);
  }
});

test('같은 키는 같은 모양이다 (글·함수·배열, 함수 인자 수)', () => {
  for (const [key, koValue] of Object.entries(CATALOGS.ko)) {
    const enValue = (CATALOGS.en as Record<string, unknown>)[key];
    assert.equal(typeof enValue, typeof koValue, `${key}의 모양이 다릅니다.`);
    assert.equal(Array.isArray(enValue), Array.isArray(koValue), `${key}의 모양이 다릅니다.`);
    if (typeof koValue === 'function' && typeof enValue === 'function') {
      assert.equal(enValue.length, koValue.length, `${key}의 인자 수가 다릅니다.`);
    }
    if (Array.isArray(koValue) && Array.isArray(enValue)) {
      assert.equal(enValue.length, koValue.length, `${key}의 조각 수가 다릅니다.`);
    }
  }
});

test('영어 판에 한글이 없다', () => {
  for (const [key, value] of Object.entries(CATALOGS.en)) {
    for (const text of render(value)) {
      assert.ok(!HANGUL.test(text), `en.${key}에 한글이 섞였습니다: ${text}`);
      assert.ok(text.trim().length > 0, `en.${key}가 비었습니다.`);
    }
  }
});

test('브라우저 언어로 판을 고른다', () => {
  assert.equal(detectLocale(['ko-KR']), 'ko');
  assert.equal(detectLocale(['ko']), 'ko');
  assert.equal(detectLocale(['en-US']), 'en');
  assert.equal(detectLocale(['ja-JP']), 'en');
  // 첫 언어를 따른다.
  assert.equal(detectLocale(['en-US', 'ko-KR']), 'en');
  assert.equal(detectLocale(['ko-KR', 'en-US']), 'ko');
  assert.equal(detectLocale([]), 'en');
  assert.equal(detectLocale(undefined), 'en');
});

test('경과 시간은 고른 언어로 찍는다', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const fiveMin = new Date(now - 5 * 60_000).toISOString();
  try {
    setLocale('en');
    assert.equal(msg().signIn, 'Sign In');
    assert.match(formatRelative(fiveMin, now), /5 min/);
    assert.ok(!HANGUL.test(formatRelative(fiveMin, now)));
    setLocale('ko');
    assert.equal(msg().signIn, '로그인');
    assert.match(formatRelative(fiveMin, now), /5분 전/);
  } finally {
    setLocale('en');
  }
});
