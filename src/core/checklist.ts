import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

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
    throw new ChecklistError('잘못된 세션 id입니다.');
  }
  return id;
}

export class ChecklistError extends Error {}

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
      throw new ChecklistError(`할 일은 세션당 ${MAX_ITEMS}개까지입니다.`);
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

  /** 완료된 항목을 한꺼번에 치운다. */
  clearDone(sessionId: string): number {
    const items = this.list(sessionId);
    const next = items.filter((i) => !i.done);
    const removed = items.length - next.length;
    if (removed > 0) this.save(sessionId, next);
    return removed;
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
