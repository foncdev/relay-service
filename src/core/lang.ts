/**
 * 서버가 만드는 글의 언어. RELAY_LANG=en이면 영어, 그 밖은 한국어(기본).
 *
 * 서버가 만든 알림 제목("할 일 완료: …")은 저장되어 폰·안경·웹이 모두 같은
 * 글을 본다. 기기마다 다르게 보여 줄 수 없으므로 서버에 언어를 하나 정한다.
 * 폰 앱은 자기가 한 일을 알림 제목으로 가려내 배너를 거르므로, 폰의 언어와
 * 같게 두어야 한다. 영어 문구는 폰 앱(iOS·Android)의 영어 문구와 글자까지 같다.
 *
 * 운영자가 보는 시작 로그·경고는 옮기지 않는다.
 */
export type Lang = 'ko' | 'en';

let current: Lang = parse(process.env.RELAY_LANG);

function parse(value: string | undefined): Lang {
  return value?.trim().toLowerCase().startsWith('en') ? 'en' : 'ko';
}

export function lang(): Lang {
  return current;
}

/** 테스트에서 바꾼다. */
export function setLang(value: Lang): void {
  current = value;
}

/** 지금 언어의 글을 고른다. */
export function L(ko: string, en: string): string {
  return current === 'en' ? en : ko;
}
