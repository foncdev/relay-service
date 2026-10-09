import type { MonitorConfig } from './config.js';
import type { Sample, Series } from './types.js';

/** 원자료를 가져오는 곳. Grafana가 기본이고, 시험·화면 만들기용 가짜가 있다. */
export interface MonitorSource {
  readonly name: string;
  sample(cfg: MonitorConfig): Promise<Sample>;
}

/**
 * Grafana의 데이터 소스 쿼리 API(/api/ds/query)로 Prometheus 쿼리를 한 번에 보낸다.
 * 토큰은 이 서버에만 둔다 — 안경·폰은 간추린 결과만 받는다.
 */
export class GrafanaSource implements MonitorSource {
  readonly name = 'grafana';
  private uid = '';

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async sample(cfg: MonitorConfig): Promise<Sample> {
    const uid = cfg.grafana.datasourceUid || this.uid || (this.uid = await this.findPrometheus(cfg));
    const prom = (refId: string, expr: string): Record<string, unknown> => ({ refId, expr, datasource: { uid }, instant: true, range: false });
    const queries = [
      ...cfg.metrics.map((m) => prom(`m_${m.key}`, m.query)),
      ...(cfg.services ? [prom('services', cfg.services.query)] : []),
      // 업무 지표는 데이터 소스를 따로 정할 수 있다. SQL이면 rawSql로, 아니면 Prometheus 쿼리로.
      ...cfg.stats.map((st) =>
        st.sql
          ? { refId: `s_${st.key}`, rawSql: st.sql, format: 'table', datasource: { uid: st.datasourceUid || uid } }
          : { ...prom(`s_${st.key}`, st.query), datasource: { uid: st.datasourceUid || uid } },
      ),
    ];

    const body = await this.request(cfg, '/api/ds/query', {
      method: 'POST',
      body: JSON.stringify({ from: 'now-5m', to: 'now', queries }),
    });
    const results = (body as { results?: Record<string, { error?: string; frames?: Frame[] }> }).results ?? {};
    const pick = (refId: string): Series[] => {
      const r = results[refId];
      if (r?.error) throw new Error(`${refId}: ${r.error}`);
      return framesToSeries(r?.frames ?? []);
    };
    // 업무 지표 하나가 실패해도 나머지는 보인다. 그 지표만 값이 빠진다.
    const one = (refId: string): number | undefined => {
      try {
        return pick(refId)[0]?.value;
      } catch {
        return undefined;
      }
    };
    return {
      metrics: Object.fromEntries(cfg.metrics.map((m) => [m.key, pick(`m_${m.key}`)])),
      services: cfg.services ? pick('services') : [],
      stats: Object.fromEntries(cfg.stats.map((st) => [st.key, one(`s_${st.key}`)])),
    };
  }

  /** Grafana의 데이터 소스 목록. 웹 설정에서 고르게 한다. */
  async datasources(cfg: MonitorConfig): Promise<Array<{ uid: string; name: string; type: string; isDefault: boolean }>> {
    const list = (await this.request(cfg, '/api/datasources')) as Array<{ uid: string; name: string; type: string; isDefault?: boolean }>;
    return list.map((d) => ({ uid: d.uid, name: d.name, type: d.type, isDefault: d.isDefault === true }));
  }

  /** 데이터 소스를 정하지 않았으면 기본(없으면 첫) Prometheus를 쓴다. */
  private async findPrometheus(cfg: MonitorConfig): Promise<string> {
    const list = (await this.request(cfg, '/api/datasources')) as Array<{ uid: string; type: string; isDefault?: boolean }>;
    const proms = list.filter((d) => d.type === 'prometheus');
    const found = proms.find((d) => d.isDefault) ?? proms[0];
    if (!found) throw new Error('Grafana에 Prometheus 데이터 소스가 없습니다. GRAFANA_DATASOURCE_UID를 정하세요.');
    return found.uid;
  }

  private async request(cfg: MonitorConfig, path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchFn(cfg.grafana.url + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(cfg.grafana.token ? { Authorization: `Bearer ${cfg.grafana.token}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Grafana ${path} ${res.status}`);
    return res.json();
  }
}

interface Frame {
  schema?: { fields?: Array<{ name?: string; type?: string; labels?: Record<string, string> }> };
  data?: { values?: unknown[][] };
}

/**
 * Grafana 데이터 프레임 → 시계열. 순간 쿼리면 시계열마다 프레임 하나에 [시각, 값] 필드가 오고,
 * 라벨은 값 필드에 붙는다. 마지막 숫자 필드의 마지막 값을 쓴다.
 */
export function framesToSeries(frames: Frame[]): Series[] {
  const out: Series[] = [];
  for (const f of frames) {
    const fields = f.schema?.fields ?? [];
    const values = f.data?.values ?? [];
    for (let i = fields.length - 1; i >= 0; i--) {
      if (fields[i]!.type !== 'number') continue;
      const column = values[i] ?? [];
      const v = Number(column[column.length - 1]);
      if (Number.isFinite(v)) out.push({ labels: fields[i]!.labels ?? {}, value: v });
      break;
    }
  }
  return out;
}

const DEMO_STATS: Record<string, (t: number) => number> = {
  orders: (t) => Math.round(1200 + 90 * Math.sin(t / 7)),
  returns: (t) => Math.round(58 + 6 * Math.sin(t / 5)),
  payment_fail: (t) => Math.round((2.1 + 0.4 * Math.sin(t / 4)) * 10) / 10,
  revenue: (t) => Math.round(4830 + 250 * Math.sin(t / 6)),
};

/**
 * 가짜 원자료. Grafana 없이 화면을 만들고 시험한다(RELAY_MONITOR=demo).
 * 그룹 셋, 서버 여러 대, 일부 주의·위험·DOWN. 값은 시각에 따라 조금씩 흔들린다.
 */
export class DemoSource implements MonitorSource {
  readonly name = 'demo';

  constructor(private readonly now: () => number = Date.now) {}

  async sample(cfg: MonitorConfig): Promise<Sample> {
    const t = this.now() / 60_000;
    const wave = (seed: number, base: number, amp: number): number => base + amp * Math.sin(t / 3 + seed);
    const hosts: Array<{ host: string; job: string; cpu: number; disk: number; mem: number; up: Record<string, boolean> }> = [
      { host: 'web-01', job: 'web', cpu: wave(1, 25, 8), disk: 41, mem: wave(2, 52, 5), up: { nginx: true, api: true } },
      { host: 'web-02', job: 'web', cpu: wave(2, 31, 8), disk: 38, mem: wave(3, 48, 5), up: { nginx: true, api: true } },
      { host: 'web-03', job: 'web', cpu: wave(3, 92, 3), disk: 44, mem: wave(4, 71, 5), up: { nginx: true, api: true, worker: false } },
      { host: 'web-04', job: 'web', cpu: wave(4, 87, 4), disk: 52, mem: wave(5, 64, 5), up: { nginx: true, api: true } },
      { host: 'db-01', job: 'db', cpu: wave(5, 45, 10), disk: 91, mem: wave(6, 78, 3), up: { postgres: true } },
      { host: 'db-02', job: 'db', cpu: wave(6, 38, 10), disk: 63, mem: wave(7, 74, 3), up: { postgres: true } },
      { host: 'stg-01', job: 'staging', cpu: wave(7, 12, 5), disk: 30, mem: wave(8, 33, 5), up: { nginx: true, api: true } },
      { host: 'stg-02', job: 'staging', cpu: wave(8, 9, 4), disk: 27, mem: wave(9, 29, 5), up: { nginx: true } },
    ];
    const series = (key: 'cpu' | 'disk' | 'mem'): Series[] =>
      hosts.map((h) => ({ labels: { instance: `${h.host}:9100`, job: h.job }, value: h[key] }));
    return {
      metrics: Object.fromEntries(
        cfg.metrics.map((m) => [m.key, m.key === 'cpu' || m.key === 'disk' || m.key === 'mem' ? series(m.key) : []]),
      ),
      services: hosts.flatMap((h) =>
        Object.entries(h.up).map(([name, up]) => ({ labels: { instance: `${h.host}:9100`, job: name }, value: up ? 1 : 0 })),
      ),
      // 업무 지표 키가 아래 이름이면 그럴듯한 값을 준다(쇼핑몰 예시 설정과 같은 키).
      stats: Object.fromEntries(cfg.stats.map((st) => [st.key, DEMO_STATS[st.key]?.(t)])),
    };
  }
}
