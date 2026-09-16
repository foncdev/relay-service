import type { NotificationKind } from './notifications.js';

/**
 * 외부 서비스가 보낸 몸통을 알림 한 건으로 옮긴다.
 *
 * 보내는 쪽을 고칠 수 있으면 {title, body}로 주면 된다. 그러나 남의
 * 서비스(GitHub·Slack·Grafana 같은 것)는 자기 형식으로만 보내고 바꿀
 * 방법이 없다. 그래서 흔한 이름들을 훑어 제목이 될 만한 것을 찾는다.
 *
 * 맞는 이름이 없으면 몸통을 그대로 글로 만들어 보여준다. 알림이 통째로
 * 사라지는 것보다 낫다 — 무엇이 왔는지 보면 사용자가 판단할 수 있다.
 */

/** 제목으로 쓸 만한 이름들. 앞에 있는 것을 먼저 본다. */
const TITLE_KEYS = ['title', 'text', 'message', 'msg', 'subject', 'summary', 'name', 'event'];

/** 본문으로 쓸 만한 이름들. */
const BODY_KEYS = ['body', 'description', 'detail', 'details', 'content', 'value'];

const MAX_TITLE = 200;
const MAX_BODY = 4000;

/** 알림 종류로 받아들이는 값. 그 외는 info로 둔다. */
const KINDS = new Set<NotificationKind>(['done', 'error', 'permission', 'info']);

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // 숫자나 참거짓도 제목이 될 수 있다. 0과 false를 놓치지 않는다.
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

/**
 * 종류를 고른다.
 *
 * 흔한 이름(level, severity, status)까지 본다. 오류를 info로 흘려보내면
 * 안경에서 갈래가 뭉개진다.
 */
function pickKind(obj: Record<string, unknown>): NotificationKind {
  const raw = pick(obj, ['kind', 'level', 'severity', 'status', 'type']).toLowerCase();
  if (KINDS.has(raw as NotificationKind)) return raw as NotificationKind;
  if (/err|fail|crit|fatal|alert/.test(raw)) return 'error';
  if (/ok|success|pass|done|resolved|complete/.test(raw)) return 'done';
  return 'info';
}

export interface HookInput {
  title: string;
  body: string;
  kind: NotificationKind;
  /** 어디서 온 알림인지. 목록에서 갈래를 잡는 데 쓴다. */
  source?: string;
}

/**
 * 받은 몸통을 알림으로 옮긴다. 제목을 못 찾으면 undefined를 준다.
 *
 * 제목이 없으면 부르는 쪽이 400으로 돌려준다. 빈 알림을 쌓아두면
 * 목록만 지저분해지고 알려주는 것이 없다.
 */
export function toNotification(raw: unknown, source?: string): HookInput | undefined {
  // 문자열 한 줄만 보내는 쪽도 있다. 그것도 받는다.
  if (typeof raw === 'string') {
    const text = raw.trim().slice(0, MAX_TITLE);
    return text ? { title: text, body: '', kind: 'info', source } : undefined;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;

  const title = pick(obj, TITLE_KEYS).slice(0, MAX_TITLE);
  let body = pick(obj, BODY_KEYS).slice(0, MAX_BODY);

  if (!title) {
    /*
     * 아는 이름이 하나도 없다. 남의 형식이라 고칠 수 없으므로 몸통을
     * 그대로 보여준다. 첫 줄을 제목으로 쓰면 적어도 무엇이 왔는지는
     * 안경에서 읽힌다.
     */
    const dump = JSON.stringify(obj, null, 1);
    if (!dump || dump === '{}') return undefined;
    const lines = dump.split('\n').filter((l) => l.trim() && !/^[{}]$/.test(l.trim()));
    const first = (lines[0] ?? '').trim().replace(/[",]/g, '');
    return {
      title: (first || '외부 알림').slice(0, MAX_TITLE),
      body: dump.slice(0, MAX_BODY),
      kind: pickKind(obj),
      source,
    };
  }

  // 제목만 있고 본문이 없으면, 남은 값들을 본문에 넣어 맥락을 살린다.
  if (!body) {
    const rest = Object.entries(obj)
      .filter(([k]) => !TITLE_KEYS.includes(k) && !BODY_KEYS.includes(k))
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${String(v)}`);
    body = rest.join('\n').slice(0, MAX_BODY);
  }

  return { title, body, kind: pickKind(obj), source };
}
