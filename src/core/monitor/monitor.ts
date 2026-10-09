import { notifications } from '../notifications.js';
import { publish } from '../events.js';
import { L } from '../lang.js';
import { buildGroups, countStates } from './build.js';
import { loadMonitorConfig, type MonitorConfig } from './config.js';
import { DemoSource, GrafanaSource, type MonitorSource } from './sources.js';
import { worst, type MonitorItem, type MonitorSnapshot, type MonitorState } from './types.js';

/** 알림을 띄울 만큼 나쁜 상태. 주의(warn)는 띄우지 않는다 — 자주 오가면 알림이 쌓이기만 한다. */
const ALERTING: MonitorState[] = ['down', 'crit'];

/**
 * 모니터링. 주기마다 원천(Grafana)을 읽어 공통 모양(MonitorSnapshot)으로 들고 있는다.
 *
 * - 대상(서버·업무 지표 묶음)이 DOWN·위험이 되면 한 번, 다시 괜찮아지면 한 번 알림을 남긴다(안경·폰에 뜬다).
 *   켜자마자 이미 나빠 있던 것은 알리지 않는다 — 서버를 다시 켤 때마다 같은 알림이 쏟아진다.
 * - 조회가 실패하면 그 전 값을 그대로 두고 stale·error를 싣는다.
 * - 값이 바뀌면 /events로 'monitor'를 알린다. 안경은 그때 다시 읽는다.
 */
export class Monitor {
  private snapshot: MonitorSnapshot;
  private timer?: ReturnType<typeof setInterval>;
  /** 대상별 지난 상태(그룹/대상). 처음 한 번은 기준만 잡는다. */
  private last?: Map<string, { state: MonitorState; item: MonitorItem; group: string }>;

  constructor(
    private readonly cfg: MonitorConfig = loadMonitorConfig(),
    private readonly source: MonitorSource | undefined = cfg.mode === 'grafana'
      ? new GrafanaSource()
      : cfg.mode === 'demo'
        ? new DemoSource()
        : undefined,
  ) {
    this.snapshot = empty(cfg, this.source?.name ?? 'off');
  }

  get enabled(): boolean {
    return this.source !== undefined;
  }

  current(): MonitorSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (!this.source || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.cfg.refreshSeconds * 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 지금 읽는다. 폰·안경의 '새로고침'도 이걸 부른다. */
  async refresh(): Promise<MonitorSnapshot> {
    if (!this.source) return this.snapshot;
    try {
      const sample = await this.source.sample(this.cfg);
      const groups = buildGroups(sample, this.cfg, L('기타', 'Other'));
      const items = groups.flatMap((g) => g.items);
      this.snapshot = {
        enabled: true,
        source: this.source.name,
        updatedAt: new Date().toISOString(),
        state: worst(groups.map((g) => g.state)),
        counts: countStates(items.map((s) => s.state)),
        groups,
      };
      this.notifyChanges(groups.flatMap((g) => g.items.map((item) => ({ group: g.name, item }))));
    } catch (err) {
      this.snapshot = { ...this.snapshot, error: (err as Error).message, stale: this.snapshot.groups.length > 0 };
    }
    publish('monitor');
    return this.snapshot;
  }

  private notifyChanges(rows: Array<{ group: string; item: MonitorItem }>): void {
    const next = new Map(rows.map((r) => [`${r.group}/${r.item.id}`, { state: r.item.state, item: r.item, group: r.group }]));
    const prev = this.last;
    this.last = next;
    if (!prev) return;
    for (const [key, now] of next) {
      const before = prev.get(key)?.state ?? 'ok';
      const bad = ALERTING.includes(now.state);
      const wasBad = ALERTING.includes(before);
      if (bad && !wasBad) {
        notifications.add({
          title: L(`[모니터링] ${now.item.name} ${stateWord(now.state)}`, `[Monitor] ${now.item.name} ${stateWord(now.state)}`),
          body: `${now.group} · ${why(now.item)}`,
          kind: 'error',
        });
      } else if (!bad && wasBad) {
        notifications.add({
          title: L(`[모니터링] ${now.item.name} 복구`, `[Monitor] ${now.item.name} recovered`),
          body: `${now.group} · ${why(now.item) || L('정상', 'OK')}`,
          kind: 'done',
        });
      }
    }
    // 사라진 대상은 알리지 않는다. 대상에서 뺀 것과 꺼진 것을 가를 수 없다(꺼지면 up이 0으로 남는다).
  }
}

function empty(cfg: MonitorConfig, source: string): MonitorSnapshot {
  return {
    enabled: cfg.mode !== 'off',
    source,
    state: 'unknown',
    counts: countStates([]),
    groups: [],
  };
}

function stateWord(s: MonitorState): string {
  if (s === 'down') return 'DOWN';
  if (s === 'crit') return L('위험', 'critical');
  if (s === 'warn') return L('주의', 'warning');
  return L('정상', 'OK');
}

/** 알림 본문 한 줄: 내려간 서비스, 위험·주의 지표. */
export function why(item: MonitorItem): string {
  const down = item.services.filter((s) => !s.up).map((s) => `${s.name} DOWN`);
  const bad = item.metrics.filter((m) => m.state !== 'ok').map((m) => `${m.label} ${m.value}${m.unit}`);
  return [...down, ...bad].join(', ');
}

export const monitor = new Monitor();
