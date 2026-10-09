import type { MetricDef, MonitorConfig } from './config.js';
import {
  STATE_RANK,
  worst,
  type MonitorGroup,
  type MonitorItem,
  type MonitorMetric,
  type MonitorService,
  type MonitorState,
  type Sample,
  type Series,
} from './types.js';

/**
 * 원자료(라벨 붙은 숫자들)를 공통 모양으로 묶고 상태를 판정한다. 순수 함수라 시험으로 본다.
 *
 * - 서버 지표는 serverLabel(기본 instance) 값으로 대상을 가른다. :포트는 뗀다(web-01:9100 → web-01).
 *   그룹은 설정의 groups(이름 패턴)가 먼저, 없으면 groupLabel(기본 job) 값, 그것도 없으면 '기타'.
 * - 업무 지표(stats)는 설정에 적힌 그룹·대상에 붙는다(쇼핑몰 → 오늘 → 주문·반품).
 * - 대상 상태는 지표·서비스 중 가장 나쁜 것, 그룹 상태는 대상 중 가장 나쁜 것.
 * - 늘 문제 있는 것이 앞에 오게 정렬한다(안경은 위에서부터 몇 줄만 보인다).
 */
export function buildGroups(sample: Sample, cfg: MonitorConfig, other: string): MonitorGroup[] {
  interface Draft {
    name: string;
    group: string;
    metrics: Map<string, MonitorMetric>;
    services: MonitorService[];
  }
  const drafts = new Map<string, Draft>();

  const serverOf = (s: Series): Draft | undefined => {
    const raw = s.labels[cfg.serverLabel];
    if (!raw) return undefined;
    const name = cfg.stripPort ? stripPort(raw) : raw;
    let d = drafts.get(`server:${name}`);
    if (!d) {
      d = { name, group: groupOf(name, s.labels, cfg, other), metrics: new Map(), services: [] };
      drafts.set(`server:${name}`, d);
    }
    return d;
  };

  for (const def of cfg.metrics) {
    for (const s of sample.metrics[def.key] ?? []) {
      const d = serverOf(s);
      if (!d || !Number.isFinite(s.value)) continue;
      // 같은 서버에 시계열이 여럿이면(잡이 둘 등) 나쁜 값을 남긴다.
      const metric = toMetric(def, s.value);
      const prev = d.metrics.get(def.key);
      if (!prev || worse(def, metric.value, prev.value)) d.metrics.set(def.key, metric);
    }
  }

  if (cfg.services) {
    for (const s of sample.services) {
      const d = serverOf(s);
      if (!d) continue;
      const name = s.labels[cfg.services.nameLabel] ?? cfg.services.nameLabel;
      const up = s.value >= 1;
      const prev = d.services.find((x) => x.name === name);
      if (prev) prev.up = prev.up && up;
      else d.services.push({ name, up });
    }
  }

  // 업무 지표: 설정의 그룹·대상에 붙인다. 값이 없으면(쿼리 실패·빈 결과) 그 지표만 빠진다.
  for (const def of cfg.stats) {
    const v = sample.stats[def.key];
    if (v === undefined || !Number.isFinite(v)) continue;
    const id = `stat:${def.group}/${def.item}`;
    let d = drafts.get(id);
    if (!d) {
      d = { name: def.item, group: def.group, metrics: new Map(), services: [] };
      drafts.set(id, d);
    }
    d.metrics.set(def.key, toMetric(def, v));
  }

  // 지표 순서는 설정 순서를 따른다.
  const order = [...cfg.metrics, ...cfg.stats].map((m) => m.key);
  const byGroup = new Map<string, MonitorItem[]>();
  for (const d of drafts.values()) {
    const metrics = order.map((k) => d.metrics.get(k)).filter((m): m is MonitorMetric => !!m);
    const services = d.services.sort((a, b) => Number(a.up) - Number(b.up) || a.name.localeCompare(b.name));
    const state = worst([
      ...metrics.map((m) => m.state),
      ...services.map((s): MonitorState => (s.up ? 'ok' : 'down')),
      ...(metrics.length === 0 && services.length === 0 ? (['unknown'] as MonitorState[]) : []),
    ]);
    const item: MonitorItem = { id: d.name, name: d.name, state, metrics, services };
    byGroup.set(d.group, [...(byGroup.get(d.group) ?? []), item]);
  }

  const groups = [...byGroup.entries()].map(([name, list]): MonitorGroup => {
    list.sort(byState);
    const services = list.flatMap((s) => s.services);
    return {
      id: name,
      name,
      state: worst(list.map((s) => s.state)),
      counts: countStates(list.map((s) => s.state)),
      servicesUp: services.filter((s) => s.up).length,
      servicesTotal: services.length,
      items: list,
    };
  });
  return groups.sort(byState);
}

export function countStates(states: MonitorState[]): Record<MonitorState, number> {
  const c: Record<MonitorState, number> = { down: 0, crit: 0, warn: 0, ok: 0, unknown: 0 };
  for (const s of states) c[s] += 1;
  return c;
}

function byState(a: { state: MonitorState; name: string }, b: { state: MonitorState; name: string }): number {
  return STATE_RANK[b.state] - STATE_RANK[a.state] || a.name.localeCompare(b.name, undefined, { numeric: true });
}

export function stripPort(v: string): string {
  // IPv6([::1]:9100)와 주소 그대로인 값도 다룬다.
  const m = /^\[(.+)\]:\d+$/.exec(v) ?? /^([^:]+):\d+$/.exec(v);
  return m ? m[1]! : v;
}

function groupOf(server: string, labels: Record<string, string>, cfg: MonitorConfig, other: string): string {
  for (const [name, patterns] of Object.entries(cfg.groups)) {
    if (patterns.some((p) => glob(p).test(server))) return name;
  }
  return labels[cfg.groupLabel] || other;
}

function glob(p: string): RegExp {
  return new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

export function toMetric(def: MetricDef, value: number): MonitorMetric {
  return {
    key: def.key,
    label: def.label,
    value: Math.round(value * 10) / 10,
    unit: def.unit,
    max: def.max,
    state: judge(def, value),
  };
}

export function judge(def: MetricDef, v: number): MonitorState {
  const over = (t?: number): boolean => t !== undefined && (def.lowerIsWorse ? v <= t : v >= t);
  if (over(def.crit)) return 'crit';
  if (over(def.warn)) return 'warn';
  return 'ok';
}

function worse(def: MetricDef, a: number, b: number): boolean {
  return def.lowerIsWorse ? a < b : a > b;
}
