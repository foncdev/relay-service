import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { L } from './lang.js';

/**
 * 세션별 할 일 목록.
 *
 * 중앙 서버가 들고 있어 맥이 꺼져 있어도 목록은 남는다.
 * 안경·폰·웹이 모두 여기를 본다.
 */

const DIR = path.join(config.dataDir, 'checklists');

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
}

/**
 * 세션과 무관한 전역 목록의 id.
 * 세션 id는 UUID라 이 값과 겹치지 않는다.
 */
export const GLOBAL_LIST = 'global';

/**
 * 세션 id를 파일명으로 쓸 수 있는지 검사한다.
 * 경로 탈출(../)과 구분자를 막는다.
 */
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new ChecklistError(L('잘못된 세션 id입니다.', 'Invalid session id.'));
  }
  return id;
}

export class ChecklistError extends Error {}

/** 폰이 정해 보내는 id. uuid를 쓰지만 모양만 막는다(파일에 그대로 들어간다). */
export const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function filePath(sessionId: string): string {
  return path.join(DIR, `${safeId(sessionId)}.json`);
}

/** 한 세션이 가질 수 있는 최대 항목 수. 무한정 쌓이는 걸 막는다. */
const MAX_ITEMS = 500;
const MAX_TEXT = 500;

export class ChecklistStore {
  constructor() {
    fs.mkdirSync(DIR, { recursive: true });
  }

  list(sessionId: string): ChecklistItem[] {
    // 검증은 try 밖에서 한다. 안에 두면 catch가 삼켜
    // 잘못된 id가 빈 목록으로 조용히 통과한다.
    const file = filePath(sessionId);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as ChecklistItem[]) : [];
    } catch {
      // 아직 목록이 없는 세션이다.
      return [];
    }
  }

  private save(sessionId: string, items: ChecklistItem[]): void {
    fs.writeFileSync(filePath(sessionId), JSON.stringify(items, null, 2));
  }

  /**
   * 여러 줄을 한 번에 넣는다. 목록 기호는 떼어낸다.
   *
   * 번호 매기기는 뒤에 점이나 괄호가 붙을 때만 기호로 본다. 숫자만
   * 적어 넣는 할 일("555" 같은 것)이 통째로 지워지면 안 된다.
   */
  addMany(sessionId: string, text: string): ChecklistItem[] {
    const lines = text
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s*(?:[-*•]+\s*|\d+[.)\]]\s*)/, '')
          .trim()
          .slice(0, MAX_TEXT),
      )
      .filter(Boolean);
    if (lines.length === 0) return [];

    const items = this.list(sessionId);
    if (items.length + lines.length > MAX_ITEMS) {
      throw new ChecklistError(L(`할 일은 세션당 ${MAX_ITEMS}개까지입니다.`, `Up to ${MAX_ITEMS} to-dos per session.`));
    }

    const added = lines.map<ChecklistItem>((line) => ({
      id: randomUUID(),
      text: line,
      done: false,
      createdAt: new Date().toISOString(),
    }));
    items.push(...added);
    this.save(sessionId, items);
    return added;
  }

  /**
   * 폰이 정한 id로 하나를 넣는다. 같은 id가 이미 있으면 그대로 둔다.
   *
   * 폰은 오프라인에서 만든 할 일을 나중에 보낸다. 보내다 끊기면 같은
   * 요청을 다시 보내게 되는데, 그때 두 번 생기면 안 된다. id를 폰이
   * 정하면 다시 보내도 하나로 남는다.
   */
  addWithId(sessionId: string, id: string, text: string): { item: ChecklistItem; created: boolean } {
    if (!CLIENT_ID.test(id)) throw new ChecklistError(L('잘못된 id입니다.', 'Invalid id.'));
    const items = this.list(sessionId);
    const existing = items.find((i) => i.id === id);
    if (existing) return { item: existing, created: false };

    const line = text.replace(/\s*\n\s*/g, ' ').trim().slice(0, MAX_TEXT);
    if (!line) throw new ChecklistError(L('추가할 내용이 없습니다.', 'Nothing to add.'));
    if (items.length + 1 > MAX_ITEMS) {
      throw new ChecklistError(L(`할 일은 세션당 ${MAX_ITEMS}개까지입니다.`, `Up to ${MAX_ITEMS} to-dos per session.`));
    }
    const item: ChecklistItem = { id, text: line, done: false, createdAt: new Date().toISOString() };
    items.push(item);
    this.save(sessionId, items);
    return { item, created: true };
  }

  /** 완료 여부를 바꾼다. done을 생략하면 뒤집는다. */
  toggle(sessionId: string, itemId: string, done?: boolean): ChecklistItem | undefined {
    const items = this.list(sessionId);
    const item = items.find((i) => i.id === itemId);
    if (!item) return undefined;

    item.done = done ?? !item.done;
    item.doneAt = item.done ? new Date().toISOString() : undefined;
    this.save(sessionId, items);
    return item;
  }

  update(sessionId: string, itemId: string, text: string): ChecklistItem | undefined {
    const items = this.list(sessionId);
    const item = items.find((i) => i.id === itemId);
    if (!item) return undefined;

    item.text = text.trim().slice(0, MAX_TEXT);
    this.save(sessionId, items);
    return item;
  }

  remove(sessionId: string, itemId: string): boolean {
    const items = this.list(sessionId);
    const next = items.filter((i) => i.id !== itemId);
    if (next.length === items.length) return false;
    this.save(sessionId, next);
    return true;
  }

  /**
   * 순서를 바꾼다. ids에 적힌 순서대로 앞에 놓고, 적히지 않은 항목은
   * 원래 순서대로 뒤에 둔다.
   *
   * 폰은 오프라인에서 끌어 옮긴 순서를 나중에 보낸다. 그 사이 다른 기기가
   * 넣은 항목이 사라지면 안 되고, 없는 id는 무시해야 다시 보내도 같다.
   */
  reorder(sessionId: string, ids: string[]): ChecklistItem[] {
    const items = this.list(sessionId);
    const byId = new Map(items.map((i) => [i.id, i]));
    const seen = new Set<string>();
    const front: ChecklistItem[] = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (item && !seen.has(id)) {
        seen.add(id);
        front.push(item);
      }
    }
    const next = [...front, ...items.filter((i) => !seen.has(i.id))];
    if (next.some((item, n) => item !== items[n])) this.save(sessionId, next);
    return next;
  }

  /** 완료된 항목을 한꺼번에 치운다. */
  clearDone(sessionId: string): number {
    const items = this.list(sessionId);
    const next = items.filter((i) => !i.done);
    const removed = items.length - next.length;
    if (removed > 0) this.save(sessionId, next);
    return removed;
  }

  /**
   * 세션마다 남은(완료하지 않은) 할 일 수. 전역 목록과 남은 것이 없는 세션은 뺀다.
   * 폰의 세션 목록이 줄마다 보인다.
   */
  openCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    let files: string[] = [];
    try {
      files = fs.readdirSync(DIR);
    } catch {
      return counts;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      if (id === GLOBAL_LIST || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) continue;
      const open = this.list(id).filter((i) => !i.done).length;
      if (open > 0) counts[id] = open;
    }
    return counts;
  }

  removeAll(sessionId: string): void {
    try {
      fs.unlinkSync(filePath(sessionId));
    } catch {
      // 없으면 넘어간다.
    }
  }
}

export const checklists = new ChecklistStore();
