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
 * - 상태(대상별 정상·주의·위험·DOWN, 읽기 실패)가 바뀌면 /events로 'monitor'를 알린다. 안경은 그때 다시 읽는다.
 *   값만 흔들릴 때는 알리지 않는다 — 30초마다 안경·폰을 깨우면 배터리만 먹는다.
 */
export class Monitor {
  private snapshot: MonitorSnapshot;
  private timer?: ReturnType<typeof setInterval>;
  /** 대상별 지난 상태(그룹/대상). 처음 한 번은 기준만 잡는다. */
  private last?: Map<string, { state: MonitorState; item: MonitorItem; group: string }>;
  /** 지난번에 알린 상태 모양. 같으면 'monitor'를 다시 알리지 않는다. */
  private published = '';

  constructor(
    private cfg: MonitorConfig = loadMonitorConfig(),
    private source: MonitorSource | undefined = sourceFor(cfg),
  ) {
    this.snapshot = empty(cfg, this.source?.name ?? 'off');
  }

  /** 지금 쓰는 설정. 토큰이 들어 있으니 밖으로 내보낼 때는 지운다. */
  get config(): MonitorConfig {
    return this.cfg;
  }

  /**
   * 설정을 바꿔 다시 시작한다(웹에서 저장했을 때). 지난 상태 기준도 버린다 —
   * 대상이 바뀌었는데 예전 기준과 견주면 엉뚱한 복구·장애 알림이 나간다.
   */
  reconfigure(cfg: MonitorConfig): void {
    const running = this.timer !== undefined;
    this.stop();
    this.cfg = cfg;
    this.source = sourceFor(cfg);
    this.last = undefined;
    this.published = '';
    this.snapshot = empty(cfg, this.source?.name ?? 'off');
    publish('monitor');
    if (running || this.source) this.start();
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
    const shape = signature(this.snapshot);
    if (shape !== this.published) {
      this.published = shape;
      publish('monitor');
    }
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

/** 상태의 모양: 그룹/대상별 상태와 읽기 실패 여부. 값은 넣지 않는다. */
export function signature(snap: MonitorSnapshot): string {
  const rows = snap.groups.flatMap((g) => g.items.map((i) => `${g.id}/${i.id}=${i.state}`));
  return `${snap.stale ? 'stale' : 'ok'}|${rows.sort().join(',')}`;
}

export function sourceFor(cfg: MonitorConfig): MonitorSource | undefined {
  if (cfg.mode === 'grafana') return new GrafanaSource();
  if (cfg.mode === 'demo') return new DemoSource();
  return undefined;
}

/**
 * 저장하지 않고 한 번 읽어 본다(웹의 '연결 시험'). 그룹·대상 모양과, Grafana면 고를 수 있는 데이터 소스를 준다.
 * 알림·이벤트는 남기지 않는다.
 */
export async function trial(cfg: MonitorConfig): Promise<{
  ok: boolean;
  error?: string;
  groups?: MonitorSnapshot['groups'];
  datasources?: Array<{ uid: string; name: string; type: string; isDefault: boolean }>;
}> {
  const source = sourceFor(cfg);
  if (!source) return { ok: false, error: L('모니터링이 꺼져 있습니다.', 'Monitoring is off.') };
  let datasources;
  if (source instanceof GrafanaSource) {
    try {
      datasources = await source.datasources(cfg);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  try {
    const groups = buildGroups(await source.sample(cfg), cfg, L('기타', 'Other'));
    return { ok: true, groups, datasources };
  } catch (err) {
    return { ok: false, error: (err as Error).message, datasources };
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
