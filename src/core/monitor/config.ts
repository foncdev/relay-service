import fs from 'node:fs';
import path from 'node:path';
import { L } from '../lang.js';

/**
 * 모니터링 설정. 환경변수만으로 켜지고, 바꾸고 싶은 것만 JSON 파일(RELAY_MONITOR_CONFIG)에 적는다.
 *
 *   RELAY_MONITOR=grafana|demo|off    기본: GRAFANA_URL이 있으면 grafana, 없으면 off
 *   GRAFANA_URL=http://grafana:3000
 *   GRAFANA_TOKEN=glsa_…               Viewer 권한 서비스 계정 토큰이면 된다
 *   GRAFANA_DATASOURCE_UID=…           비우면 기본 Prometheus 데이터 소스를 찾는다
 *   RELAY_MONITOR_CONFIG=/app/data/monitor.json
 *
 * 기본 쿼리는 Prometheus + node_exporter다. 다른 구성이면 metrics·services의 쿼리를 바꾼다.
 * 서버가 아닌 업무 지표(쇼핑몰 오늘 주문·반품 등)는 stats에 그룹·대상을 적어 더한다. 예:
 *
 *   "stats": [
 *     { "group": "쇼핑몰", "item": "오늘", "key": "orders", "label": "주문", "unit": "건",
 *       "query": "sum(increase(shop_orders_total[1d]))", "warn": 500, "lowerIsWorse": true },
 *     { "group": "쇼핑몰", "item": "오늘", "key": "returns", "label": "반품", "unit": "건",
 *       "datasourceUid": "mysql-uid", "sql": "SELECT count(*) FROM returns WHERE created_at >= CURDATE()",
 *       "warn": 50, "crit": 100 }
 *   ]
 */

export interface MetricDef {
  key: string;
  label: string;
  /** Prometheus 쿼리. 결과 시계열마다 serverLabel로 서버를 가른다 */
  query: string;
  unit: string;
  max?: number;
  /** 이 값 이상이면 주의·위험(낮을수록 나쁜 지표면 lowerIsWorse) */
  warn?: number;
  crit?: number;
  lowerIsWorse?: boolean;
}

/** 서버가 아닌 업무 지표 하나. 대상(item)을 직접 정하고 값 하나를 읽는다. */
export interface StatDef extends MetricDef {
  group: string;
  item: string;
  /** 이 지표만 다른 데이터 소스(MySQL 등)에서 읽을 때 */
  datasourceUid?: string;
  /** SQL 데이터 소스면 query 대신 이걸 쓴다(rawSql). 결과의 마지막 숫자 칸을 값으로 쓴다 */
  sql?: string;
}

export interface MonitorConfig {
  mode: 'grafana' | 'demo' | 'off';
  refreshSeconds: number;
  grafana: { url: string; token: string; datasourceUid: string };
  /** 서버를 가르는 라벨. 값의 :포트는 뗀다(stripPort) */
  serverLabel: string;
  stripPort: boolean;
  /** 그룹을 가르는 라벨. groups에 서버를 직접 적으면 그게 먼저다 */
  groupLabel: string;
  /** 그룹 이름 → 서버 이름 패턴(* 가능). 예: {"운영 웹": ["web-*"], "DB": ["db-*"]} */
  groups: Record<string, string[]>;
  metrics: MetricDef[];
  /** 서비스 UP/DOWN. 값이 1이면 UP. 이름은 nameLabel 값 */
  services: { query: string; nameLabel: string } | null;
  /** 업무 지표. 기본은 없다 */
  stats: StatDef[];
}

/** 기본 지표(Prometheus + node_exporter). 이름은 서버 언어(RELAY_LANG)를 따른다. */
export function defaultMetrics(): MetricDef[] {
  return [
    {
      key: 'cpu',
      label: 'CPU',
      query: '100 - avg by (instance, job) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100',
      unit: '%',
      max: 100,
      warn: 80,
      crit: 95,
    },
    {
      key: 'disk',
      label: L('디스크', 'Disk'),
      // 가장 많이 찬 파일시스템. 임시·가상 파일시스템은 뺀다.
      query:
        'max by (instance, job) ((1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs|devtmpfs"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs|devtmpfs"}) * 100)',
      unit: '%',
      max: 100,
      warn: 85,
      crit: 95,
    },
    {
      key: 'mem',
      label: L('메모리', 'Memory'),
      query: '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100',
      unit: '%',
      max: 100,
      warn: 85,
      crit: 95,
    },
  ];
}

/** 가짜 데이터(demo)일 때 보일 업무 지표 예시. monitor.example.json과 같다. */
export function demoStats(): StatDef[] {
  const shop = L('쇼핑몰', 'Shop');
  const today = L('오늘', 'Today');
  return [
    { group: shop, item: today, key: 'orders', label: L('주문', 'Orders'), unit: L('건', ''), query: 'sum(increase(shop_orders_total[1d]))', warn: 500, crit: 200, lowerIsWorse: true },
    { group: shop, item: today, key: 'returns', label: L('반품', 'Returns'), unit: L('건', ''), query: 'sum(increase(shop_returns_total[1d]))', warn: 50, crit: 100 },
    { group: shop, item: today, key: 'payment_fail', label: L('결제 실패율', 'Payment failures'), unit: '%', max: 10, query: 'sum(increase(shop_payment_failed_total[1d])) / sum(increase(shop_payment_total[1d])) * 100', warn: 3, crit: 5 },
  ];
}

/**
 * 웹 관리 화면(모니터링 › 설정)에서 바꿔 relay 데이터 폴더(data/monitor.json)에 저장하는 값.
 * 적은 것만 기본값을 덮는다. 토큰도 여기 둘 수 있다 — 파일 권한을 600으로 둔다.
 */
export interface MonitorSettings {
  mode?: MonitorConfig['mode'];
  refreshSeconds?: number;
  grafana?: { url?: string; token?: string; datasourceUid?: string };
  serverLabel?: string;
  stripPort?: boolean;
  groupLabel?: string;
  groups?: Record<string, string[]>;
  metrics?: MetricDef[];
  services?: { query: string; nameLabel: string } | null;
  stats?: StatDef[];
}

/** 환경변수로 정해 웹에서 바꿀 수 없는 값. */
export interface MonitorLocks {
  mode: boolean;
  url: boolean;
  token: boolean;
  datasourceUid: boolean;
}

export function envLocks(env: NodeJS.ProcessEnv = process.env): MonitorLocks {
  return {
    mode: !!env.RELAY_MONITOR?.trim(),
    url: !!env.GRAFANA_URL?.trim(),
    token: !!env.GRAFANA_TOKEN?.trim(),
    datasourceUid: !!env.GRAFANA_DATASOURCE_UID?.trim(),
  };
}

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.resolve(env.RELAY_DATA_DIR ?? './data'), 'monitor.json');
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): MonitorSettings {
  const file = settingsFile(env);
  if (!fs.existsSync(file)) return {};
  try {
    return validateSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // 손으로 고치다 깨진 파일 때문에 서버가 서지 않으면 안 된다. 없는 것으로 본다.
    return {};
  }
}

export function saveSettings(s: MonitorSettings, env: NodeJS.ProcessEnv = process.env): void {
  const file = settingsFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** 받은 값을 검사해 MonitorSettings로. 틀리면 무엇이 틀렸는지 담아 던진다. */
export function validateSettings(raw: unknown): MonitorSettings {
  const fail = (what: string): never => {
    throw new Error(L(`설정이 올바르지 않습니다: ${what}`, `Invalid settings: ${what}`));
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('object');
  const r = raw as Record<string, unknown>;
  const out: MonitorSettings = {};
  const str = (v: unknown, name: string): string => (typeof v === 'string' ? v.trim() : fail(name));
  const num = (v: unknown, name: string): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : fail(name);
  };

  if (r.mode !== undefined) {
    if (r.mode !== 'grafana' && r.mode !== 'demo' && r.mode !== 'off') fail('mode');
    out.mode = r.mode as MonitorConfig['mode'];
  }
  if (r.refreshSeconds !== undefined) out.refreshSeconds = Math.max(10, num(r.refreshSeconds, 'refreshSeconds') ?? 30);
  if (r.grafana !== undefined) {
    const g = (r.grafana ?? {}) as Record<string, unknown>;
    out.grafana = {};
    if (g.url !== undefined) {
      const url = str(g.url, 'grafana.url').replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s]+$/.test(url)) fail('grafana.url');
      out.grafana.url = url;
    }
    if (g.token !== undefined) out.grafana.token = str(g.token, 'grafana.token');
    if (g.datasourceUid !== undefined) out.grafana.datasourceUid = str(g.datasourceUid, 'grafana.datasourceUid');
  }
  if (r.serverLabel !== undefined) out.serverLabel = str(r.serverLabel, 'serverLabel') || 'instance';
  if (r.groupLabel !== undefined) out.groupLabel = str(r.groupLabel, 'groupLabel') || 'job';
  if (r.stripPort !== undefined) out.stripPort = r.stripPort === true;
  if (r.groups !== undefined) {
    if (!r.groups || typeof r.groups !== 'object' || Array.isArray(r.groups)) fail('groups');
    out.groups = {};
    for (const [name, pats] of Object.entries(r.groups as Record<string, unknown>)) {
      if (!name.trim() || !Array.isArray(pats)) fail(`groups.${name}`);
      out.groups[name.trim()] = (pats as unknown[]).map((p) => str(p, `groups.${name}`)).filter(Boolean);
    }
  }
  const metric = (m: unknown, at: string): MetricDef => {
    const x = (m ?? {}) as Record<string, unknown>;
    const key = str(x.key, `${at}.key`);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) fail(`${at}.key`);
    const def: MetricDef = {
      key,
      label: str(x.label, `${at}.label`) || key,
      query: typeof x.query === 'string' ? x.query.trim() : '',
      unit: typeof x.unit === 'string' ? x.unit : '',
    };
    const max = num(x.max, `${at}.max`);
    const warn = num(x.warn, `${at}.warn`);
    const crit = num(x.crit, `${at}.crit`);
    if (max !== undefined) def.max = max;
    if (warn !== undefined) def.warn = warn;
    if (crit !== undefined) def.crit = crit;
    if (x.lowerIsWorse === true) def.lowerIsWorse = true;
    return def;
  };
  const uniqueKeys = (list: MetricDef[], at: string): void => {
    const seen = new Set<string>();
    for (const m of list) {
      if (seen.has(m.key)) fail(`${at}: ${m.key}`);
      seen.add(m.key);
    }
  };
  if (r.metrics !== undefined) {
    if (!Array.isArray(r.metrics)) fail('metrics');
    out.metrics = (r.metrics as unknown[]).map((m, i) => metric(m, `metrics[${i}]`));
    if (out.metrics.some((m) => !m.query)) fail('metrics.query');
    uniqueKeys(out.metrics, 'metrics');
  }
  if (r.services !== undefined) {
    if (r.services === null) out.services = null;
    else {
      const sv = r.services as Record<string, unknown>;
      const query = str(sv.query, 'services.query');
      out.services = query ? { query, nameLabel: str(sv.nameLabel ?? 'job', 'services.nameLabel') || 'job' } : null;
    }
  }
  if (r.stats !== undefined) {
    if (!Array.isArray(r.stats)) fail('stats');
    out.stats = (r.stats as unknown[]).map((m, i) => {
      const x = (m ?? {}) as Record<string, unknown>;
      const def: StatDef = { ...metric(m, `stats[${i}]`), group: str(x.group, `stats[${i}].group`), item: str(x.item, `stats[${i}].item`) };
      if (!def.group || !def.item) fail(`stats[${i}].group/item`);
      if (typeof x.sql === 'string' && x.sql.trim()) def.sql = x.sql.trim();
      if (typeof x.datasourceUid === 'string' && x.datasourceUid.trim()) def.datasourceUid = x.datasourceUid.trim();
      if (!def.query && !def.sql) fail(`stats[${i}].query`);
      return def;
    });
    uniqueKeys([...(out.metrics ?? []), ...out.stats], 'stats');
  }
  return out;
}

/**
 * 설정을 모은다. 뒤의 것이 앞의 것을 덮는다:
 *   기본값 → RELAY_MONITOR_CONFIG 파일 → 웹에서 저장한 값(data/monitor.json) → 환경변수(모드·주소·토큰·데이터 소스)
 */
export function loadMonitorConfig(env: NodeJS.ProcessEnv = process.env, saved: MonitorSettings = readSettings(env)): MonitorConfig {
  const envUrl = (env.GRAFANA_URL ?? '').trim().replace(/\/+$/, '');
  const modeEnv = (env.RELAY_MONITOR ?? '').trim();

  let file: Partial<MonitorConfig> = {};
  const path0 = env.RELAY_MONITOR_CONFIG;
  if (path0 && fs.existsSync(path0)) file = JSON.parse(fs.readFileSync(path0, 'utf8')) as Partial<MonitorConfig>;

  const url = envUrl || saved.grafana?.url || file.grafana?.url?.replace(/\/+$/, '') || '';
  const modeSet = modeEnv === 'grafana' || modeEnv === 'demo' || modeEnv === 'off' ? modeEnv : saved.mode;
  const mode: MonitorConfig['mode'] = modeSet ?? (url ? 'grafana' : 'off');

  const cfg: MonitorConfig = {
    mode,
    refreshSeconds: 30,
    serverLabel: 'instance',
    stripPort: true,
    groupLabel: 'job',
    groups: {},
    metrics: defaultMetrics(),
    services: { query: 'up', nameLabel: 'job' },
    stats: [],
    ...file,
    ...stripUndefined({
      refreshSeconds: saved.refreshSeconds,
      serverLabel: saved.serverLabel,
      stripPort: saved.stripPort,
      groupLabel: saved.groupLabel,
      groups: saved.groups,
      metrics: saved.metrics,
      services: saved.services,
      stats: saved.stats,
    }),
    // 토큰은 환경변수나 웹에서 저장한 값만 쓴다. RELAY_MONITOR_CONFIG 파일에는 비밀값을 두지 않는다.
    grafana: {
      url,
      token: (env.GRAFANA_TOKEN ?? '').trim() || saved.grafana?.token || '',
      datasourceUid:
        (env.GRAFANA_DATASOURCE_UID ?? '').trim() || saved.grafana?.datasourceUid || file.grafana?.datasourceUid || '',
    },
  };
  cfg.refreshSeconds = Math.max(10, Number(cfg.refreshSeconds) || 30);
  // 가짜 데이터인데 업무 지표를 따로 정하지 않았으면 쇼핑몰 예시를 단다.
  if (cfg.mode === 'demo' && file.stats === undefined && saved.stats === undefined) cfg.stats = demoStats();
  return cfg;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
