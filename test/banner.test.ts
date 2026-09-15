/**
 * 배너 검증.
 *
 * 배너는 세 곳(서버·웹·폰)에 복제돼 있다. 로그인 화면은 인증 전이라
 * 서버에서 받아올 수 없어 어쩔 수 없이 나눠 뒀다.
 * 한쪽만 고치면 화면마다 다른 로고가 뜨므로 여기서 묶어둔다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BANNER, GLASSES_LOGO, TAGLINE } from '../src/core/banner.js';

/**
 * 옆에 있는 다른 패키지의 파일을 읽는다. 없으면 null.
 *
 * 이 저장소만 단독으로 받으면 그 파일들이 없다. 그때는 검사를 건너뛴다 —
 * 모노레포에서 함께 볼 때만 의미가 있는 확인이라서다.
 */
function readSibling(rel: string): string | null {
  const full = path.resolve(import.meta.dirname, '..', rel);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/** 다른 패키지의 배너 파일에서 BANNER 값을 꺼낸다. */
function readCopy(src: string, file: string): { banner: string; tagline: string } {
  const banner = /export const BANNER = String\.raw`\n([\s\S]*?)`\.trim\(\);/.exec(src);
  const tagline = /export const TAGLINE = '([^']*)';/.exec(src);
  assert.ok(banner, `${file}에서 BANNER를 찾지 못했습니다.`);
  assert.ok(tagline, `${file}에서 TAGLINE을 찾지 못했습니다.`);
  return { banner: banner[1]!.trim(), tagline: tagline[1]! };
}

const COPIES = ['../web/src/banner.ts', '../glasses/src/banner.ts'];

test('배너는 6줄이고 줄 길이가 모두 같다', () => {
  const lines = BANNER.split('\n');
  assert.equal(lines.length, 6);
  // 길이가 다르면 글자가 어긋나 로고가 깨진다.
  const widths = new Set(lines.map((l) => l.length));
  assert.equal(widths.size, 1, `줄 길이가 제각각입니다: ${[...widths].join(', ')}`);
});

test('배너에 안경 폰트에 없는 문자만 쓴다는 걸 명시한다', (t) => {
  // 박스드로잉 문자는 G2에서 빈칸이 된다. 안경 코드가 이걸 쓰면 안 된다.
  const relay = readSibling('../relay/src/core/relay.ts');
  if (relay === null) return t.skip('relay 패키지가 없습니다 (단독 저장소)');

  assert.ok(!/[█░╔╗╚╝═║]/.test(relay), 'relay 코어가 안경에 못 쓰는 문자를 쓰고 있습니다.');
});

for (const file of COPIES) {
  test(`${file} 복제본이 서버와 같다`, (t) => {
    const src = readSibling(file);
    if (src === null) return t.skip(`${file}이 없습니다 (단독 저장소)`);

    const copy = readCopy(src, file);
    assert.equal(copy.banner, BANNER, '배너가 서버와 다릅니다. 한쪽만 고쳤는지 확인하세요.');
    assert.equal(copy.tagline, TAGLINE, '태그라인이 서버와 다릅니다.');
  });
}

test('안경 로고가 relay 코어와 같다', (t) => {
  const src = readSibling('../relay/src/core/logo.ts');
  if (src === null) return t.skip('relay 패키지가 없습니다 (단독 저장소)');

  const m = /export const GLASSES_LOGO = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, 'relay/src/core/logo.ts에서 GLASSES_LOGO를 찾지 못했습니다.');
  const copy = [...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
  assert.deepEqual(copy, GLASSES_LOGO, '안경 로고가 서버와 다릅니다.');
});

test('안경 로고는 안경 폰트에 있는 문자만 쓴다', () => {
  // 겹선(═ ║ ╔ ╗)과 블록(█ ░)은 G2에서 빈칸이 된다. 화면으로 확인했다.
  const joined = GLASSES_LOGO.join('');
  assert.ok(!/[═║╔╗╚╝█░▓▒]/.test(joined), '안경에 안 보이는 문자가 섞였습니다.');

  // 줄 길이가 다르면 글자가 어긋난다.
  const widths = new Set(GLASSES_LOGO.map((l) => l.length));
  assert.equal(widths.size, 1, `줄 길이가 제각각입니다: ${[...widths].join(', ')}`);

  // 옆 패널은 한 줄 30자다.
  assert.ok(GLASSES_LOGO[0]!.length <= 30, '옆 패널 폭을 넘습니다.');
});
