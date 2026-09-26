import { snippets, type Snippet } from './snippets.js';
import { notifications } from './notifications.js';
import { publish } from './events.js';
import type { AgentRegistry } from './agents.js';

/**
 * 예약한 명령을 주기마다 돌린다.
 *
 * 결과가 달라졌을 때만 알림을 남기는 것이 기본이다. 매 10분 "정상"을
 * 띄우면 알림이 쌓이기만 하고 정작 이상할 때 눈에 띄지 않는다.
 *
 * 크론 문법은 받지 않는다. 분 단위 주기로 충분하고, 파서를 들이면
 * 이 파일이 할 일보다 커진다.
 */

/** 얼마나 자주 "돌릴 것이 있나" 살피는지. */
const TICK_MS = 60_000;

/** 알림 제목·본문에 넣을 출력 길이. 안경 화면이 좁다. */
const MAX_BODY = 1500;

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly termAgents: AgentRegistry) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 지금 돌려야 할 것을 골라 실행한다. */
  private async tick(): Promise<void> {
    // 맥이 꺼져 있으면 할 일이 없다. 조용히 넘긴다 — 여기서 알림을
    // 남기면 맥을 끌 때마다 알림이 쌓인다.
    if (!this.termAgents.default()) return;

    for (const s of snippets.list()) {
      if (s.kind !== 'cron' || !s.everyMinutes) continue;
      if (!this.isDue(s)) continue;
      // 하나가 실패해도 나머지는 돌려야 한다.
      await this.runOne(s).catch(() => undefined);
    }
  }

  private isDue(s: Snippet): boolean {
    if (!s.lastRunAt) return true;
    const last = new Date(s.lastRunAt).getTime();
    if (Number.isNaN(last)) return true;
    return Date.now() - last >= (s.everyMinutes ?? 10) * 60_000;
  }

  private async runOne(s: Snippet): Promise<void> {
    const agent = this.termAgents.default();
    if (!agent) return;

    // 예약 실행은 사람이 보고 있지 않다. 확인이 필요한 명령은 돌리지
    // 않는다 — 물어볼 상대가 없는데 되돌릴 수 없는 일을 하면 안 된다.
    const reply = await agent.request(
      'POST',
      '/run',
      JSON.stringify({ command: s.command, dir: s.dir, confirm: false }),
    );

    if (reply.status === 409) {
      // 위험하다고 막혔다. 한 번 알리고 예약을 끈다. 매 주기마다
      // 같은 경고를 띄우면 알림이 쏟아진다.
      snippets.update(s.id, { kind: 'once' });
      this.notify(
        `예약 취소: ${s.label}`,
        '되돌릴 수 없는 명령이라 예약 실행에서 제외했습니다.\n웹에서 직접 실행하세요.',
        'error',
      );
      return;
    }

    if (reply.status !== 200) return;

    const parsed = JSON.parse(reply.body) as { output?: string; exitCode?: number };
    const output = parsed.output ?? '';
    const exitCode = parsed.exitCode ?? -1;

    const before = s.lastOutput;
    snippets.recordRun(s.id, output, exitCode);

    const mode = s.notifyOn ?? 'change';
    if (mode === 'never') return;
    // 첫 실행은 견줄 것이 없다. 기준만 잡고 넘어간다 — 등록 직후
    // "바뀌었다"고 띄우면 사용자가 무엇이 바뀐 줄 안다.
    if (mode === 'change') {
      if (before === undefined) return;
      if (before === output) return;
    }

    this.notify(
      `${s.label}${exitCode === 0 ? '' : ` (종료 ${exitCode})`}`,
      output.trim().slice(0, MAX_BODY) || '(출력 없음)',
      exitCode === 0 ? 'info' : 'error',
    );
  }

  private notify(title: string, body: string, kind: 'info' | 'error'): void {
    try {
      notifications.add({ title, body, kind });
      publish('notifications');
    } catch {
      // 알림을 못 남겨도 예약은 계속 돈다.
    }
  }
}
