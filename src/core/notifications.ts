import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

/**
 * 알림 보관함.
 *
 * 지금까지 완료 알림은 안경에 한 번 뜨고 사라졌다. 놓치면 끝이라
 * 서버에 쌓아두고 안경·폰·웹이 같은 목록을 보게 한다.
 *
 * 체크리스트와 달리 세션별로 나누지 않는다. 알림은 "언제 무슨 일이
 * 있었나"를 시간순으로 보는 것이라 한 곳에 모으는 편이 쓸모 있다.
 */

const FILE = path.join(config.dataDir, 'notifications.json');

export type NotificationKind = 'done' | 'error' | 'permission' | 'info';

export interface Notification {
  id: string;
  /** 한 줄 제목. 목록에 보이는 부분이다. */
  title: string;
  /** 자세한 내용. 목록에서 고르면 보여준다. */
  body: string;
  kind: NotificationKind;
  /** 어느 세션에서 나온 알림인지. 없을 수도 있다. */
  sessionId?: string;
  createdAt: string;
  readAt?: string;
}

/**
 * 보관 상한.
 *
 * 알림은 사용자가 지우지 않아도 계속 들어온다. 상한이 없으면
 * 파일이 무한정 커져 읽기가 느려지므로 오래된 것부터 버린다.
 */
const MAX_ITEMS = 300;
const MAX_TITLE = 200;
const MAX_BODY = 4000;

export class NotificationError extends Error {}

export class NotificationStore {
  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  list(): Notification[] {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as Notification[]) : [];
    } catch {
      // 아직 알림이 없다.
      return [];
    }
  }

  private save(items: Notification[]): void {
    fs.writeFileSync(FILE, JSON.stringify(items, null, 2));
  }

  /** 안 읽은 개수. 홈 화면에 띄운다. */
  unreadCount(): number {
    return this.list().filter((n) => !n.readAt).length;
  }

  add(input: {
    title: string;
    body?: string;
    kind?: NotificationKind;
    sessionId?: string;
  }): Notification {
    const title = input.title.trim().slice(0, MAX_TITLE);
    if (!title) throw new NotificationError('알림 제목이 비었습니다.');

    const item: Notification = {
      id: randomUUID(),
      title,
      body: (input.body ?? '').slice(0, MAX_BODY),
      kind: input.kind ?? 'info',
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
    };

    // 최신이 앞에 오게 둔다. 안경에서 위부터 읽는다.
    const items = [item, ...this.list()].slice(0, MAX_ITEMS);
    this.save(items);
    return item;
  }

  /** 하나를 읽음 처리한다. 이미 읽었으면 그대로 둔다. */
  markRead(id: string): Notification | undefined {
    const items = this.list();
    const item = items.find((n) => n.id === id);
    if (!item) return undefined;
    if (!item.readAt) {
      item.readAt = new Date().toISOString();
      this.save(items);
    }
    return item;
  }

  markAllRead(): number {
    const items = this.list();
    const now = new Date().toISOString();
    let changed = 0;
    for (const n of items) {
      if (!n.readAt) {
        n.readAt = now;
        changed += 1;
      }
    }
    if (changed > 0) this.save(items);
    return changed;
  }

  remove(id: string): boolean {
    const items = this.list();
    const next = items.filter((n) => n.id !== id);
    if (next.length === items.length) return false;
    this.save(next);
    return true;
  }

  /** 읽은 알림을 한꺼번에 치운다. */
  clearRead(): number {
    const items = this.list();
    const next = items.filter((n) => !n.readAt);
    const removed = items.length - next.length;
    if (removed > 0) this.save(next);
    return removed;
  }
}

export const notifications = new NotificationStore();
