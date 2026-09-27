import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { CLIENT_ID } from './checklist.js';

/**
 * 미리 등록해 두는 명령.
 *
 * 안경은 입력이 탭·스크롤 네 가지뿐이라 명령을 적어 넣을 수 없다.
 * 그래서 웹에서 미리 등록하고 안경에서는 골라 실행한다.
 *
 * 목록은 이 서버가 들고 실행은 terminal-agent가 한다. 맥이 꺼져 있어도
 * 목록은 남아야 하기 때문이다 — 켜고 나서 바로 고를 수 있다.
 */

const FILE = path.join(config.dataDir, 'snippets.json');

export type SnippetKind = 'once' | 'cron';

export interface Snippet {
  id: string;
  /** 안경 목록에 보이는 이름. 짧아야 한다. */
  label: string;
  command: string;
  /** 실행할 디렉터리. 비우면 agent가 정한 기본 위치. */
  dir?: string;
  kind: SnippetKind;
  /**
   * kind가 cron일 때의 주기. 분 단위로만 받는다.
   * 크론 문법을 다 받으면 파서가 필요해 커진다.
   */
  everyMinutes?: number;
  /**
   * 예약 실행 결과를 알림으로 남길 기준.
   *  - 'change': 지난번과 달라졌을 때만. 기본값이다.
   *  - 'always': 돌 때마다.
   *  - 'never' : 남기지 않는다.
   */
  notifyOn?: 'change' | 'always' | 'never';
  createdAt: string;
  /** 마지막으로 돌린 시각과 출력. 변화를 견주는 데 쓴다. */
  lastRunAt?: string;
  lastOutput?: string;
  lastExitCode?: number;
}

const MAX_ITEMS = 100;
const MAX_LABEL = 40;
const MAX_COMMAND = 2000;
/** 견주기용으로만 들고 있으므로 길게 둘 필요가 없다. */
const MAX_KEPT_OUTPUT = 4000;

export class SnippetError extends Error {}

export class SnippetStore {
  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  list(): Snippet[] {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as Snippet[]) : [];
    } catch {
      // 아직 등록한 것이 없다.
      return [];
    }
  }

  private save(items: Snippet[]): void {
    fs.writeFileSync(FILE, JSON.stringify(items, null, 2));
  }

  get(id: string): Snippet | undefined {
    return this.list().find((s) => s.id === id);
  }

  add(input: {
    /** 폰이 정한 id. 없으면 여기서 만든다. */
    id?: string;
    label?: string;
    command: string;
    dir?: string;
    kind?: SnippetKind;
    everyMinutes?: number;
    notifyOn?: Snippet['notifyOn'];
  }): Snippet {
    const command = input.command.trim().slice(0, MAX_COMMAND);
    if (!command) throw new SnippetError('명령이 비었습니다.');
    if (input.id !== undefined && !CLIENT_ID.test(input.id)) throw new SnippetError('잘못된 id입니다.');

    // 이름을 안 주면 명령 앞부분을 쓴다. 목록에 빈 줄이 생기지 않게.
    const label = (input.label?.trim() || command).slice(0, MAX_LABEL);

    const items = this.list();
    if (items.length >= MAX_ITEMS) {
      throw new SnippetError(`명령은 ${MAX_ITEMS}개까지입니다.`);
    }

    const kind: SnippetKind = input.kind === 'cron' ? 'cron' : 'once';
    const item: Snippet = {
      id: input.id ?? randomUUID(),
      label,
      command,
      dir: input.dir?.trim() || undefined,
      kind,
      // 주기는 1분보다 촘촘하게 두지 않는다. 맥에 부담이 되고,
      // 알림이 쏟아지면 쓸모가 없다.
      everyMinutes:
        kind === 'cron' ? Math.max(1, Math.min(input.everyMinutes ?? 10, 1440)) : undefined,
      notifyOn: kind === 'cron' ? (input.notifyOn ?? 'change') : undefined,
      createdAt: new Date().toISOString(),
    };

    items.push(item);
    this.save(items);
    return item;
  }

  update(id: string, patch: Partial<Omit<Snippet, 'id' | 'createdAt'>>): Snippet | undefined {
    const items = this.list();
    const item = items.find((s) => s.id === id);
    if (!item) return undefined;

    if (patch.label !== undefined) item.label = patch.label.trim().slice(0, MAX_LABEL);
    if (patch.command !== undefined) {
      const c = patch.command.trim().slice(0, MAX_COMMAND);
      if (!c) throw new SnippetError('명령이 비었습니다.');
      item.command = c;
    }
    if (patch.dir !== undefined) item.dir = patch.dir.trim() || undefined;
    if (patch.kind !== undefined) item.kind = patch.kind === 'cron' ? 'cron' : 'once';
    if (patch.everyMinutes !== undefined) {
      item.everyMinutes = Math.max(1, Math.min(patch.everyMinutes, 1440));
    }
    if (patch.notifyOn !== undefined) item.notifyOn = patch.notifyOn;

    // once로 되돌리면 예약에 쓰던 값은 지운다. 남겨두면 다시 cron으로
    // 바꿀 때 옛 주기가 조용히 되살아난다.
    if (item.kind === 'once') {
      item.everyMinutes = undefined;
      item.notifyOn = undefined;
    }

    this.save(items);
    return item;
  }

  /** 실행 결과를 적어 둔다. 다음 실행과 견줘 변화를 본다. */
  recordRun(id: string, output: string, exitCode: number): void {
    const items = this.list();
    const item = items.find((s) => s.id === id);
    if (!item) return;
    item.lastRunAt = new Date().toISOString();
    item.lastOutput = output.slice(0, MAX_KEPT_OUTPUT);
    item.lastExitCode = exitCode;
    this.save(items);
  }

  remove(id: string): boolean {
    const items = this.list();
    const next = items.filter((s) => s.id !== id);
    if (next.length === items.length) return false;
    this.save(next);
    return true;
  }
}

export const snippets = new SnippetStore();
