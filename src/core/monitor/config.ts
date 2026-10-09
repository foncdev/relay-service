import fs from 'node:fs';
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
    { group: shop, item: today, key: 'payment_fail', label: L('결제 실패율', 'Payment failures'), unit: '%', max: 10, query: '', warn: 3, crit: 5 },
  ];
}

export function loadMonitorConfig(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  const url = (env.GRAFANA_URL ?? '').replace(/\/+$/, '');
  const modeEnv = (env.RELAY_MONITOR ?? '').trim();
  const mode: MonitorConfig['mode'] =
    modeEnv === 'grafana' || modeEnv === 'demo' || modeEnv === 'off' ? modeEnv : url ? 'grafana' : 'off';

  const base: MonitorConfig = {
    mode,
    refreshSeconds: 30,
    grafana: { url, token: env.GRAFANA_TOKEN ?? '', datasourceUid: env.GRAFANA_DATASOURCE_UID ?? '' },
    serverLabel: 'instance',
    stripPort: true,
    groupLabel: 'job',
    groups: {},
    metrics: defaultMetrics(),
    services: { query: 'up', nameLabel: 'job' },
    stats: [],
  };

  const file = env.RELAY_MONITOR_CONFIG;
  if (!file || !fs.existsSync(file)) return mode === 'demo' ? { ...base, stats: demoStats() } : base;
  const over = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MonitorConfig>;
  return {
    ...base,
    ...over,
    // 토큰·주소는 환경변수가 이긴다. 파일에는 비밀값을 두지 않는다.
    grafana: { ...base.grafana, ...(over.grafana ?? {}), url: url || over.grafana?.url || '', token: base.grafana.token },
    refreshSeconds: Math.max(10, Number(over.refreshSeconds ?? base.refreshSeconds)),
  };
}
