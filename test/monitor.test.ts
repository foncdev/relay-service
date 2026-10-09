/**
 * 모니터링: Grafana에서 무엇이 오든 그룹 → 대상 → 지표·서비스 공통 모양으로 묶고,
 * 상태를 판정하고, 나빠지고 나아질 때 한 번씩 알린다.
 *
 * 알림 저장 위치는 모듈을 읽는 시점에 정해진다. import보다 먼저 RELAY_DATA_DIR을 임시 폴더로 돌린다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.RELAY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));

const { buildGroups, stripPort, judge } = await import('../src/core/monitor/build.js');
const { loadMonitorConfig, defaultMetrics } = await import('../src/core/monitor/config.js');
const { GrafanaSource, DemoSource, framesToSeries } = await import('../src/core/monitor/sources.js');
const { Monitor } = await import('../src/core/monitor/monitor.js');
const { notifications } = await import('../src/core/notifications.js');

type Cfg = ReturnType<typeof loadMonitorConfig>;
const base = (): Cfg => ({ ...loadMonitorConfig({ RELAY_MONITOR: 'demo' }), stats: [] });
const s = (instance: string, job: string, value: number) => ({ labels: { instance, job }, value });

test('서버는 instance(포트 뗌)로, 그룹은 job으로 묶고, 문제 있는 것이 앞에 온다', () => {
  const groups = buildGroups(
    {
      metrics: {
        cpu: [s('web-01:9100', 'web', 23), s('web-02:9100', 'web', 97), s('db-01:9100', 'db', 40)],
        disk: [s('web-01:9100', 'web', 40), s('web-02:9100', 'web', 41), s('db-01:9100', 'db', 88)],
        mem: [],
      },
      services: [s('web-01:9100', 'nginx', 1), s('web-01:9100', 'worker', 0), s('db-01:9100', 'postgres', 1)],
      stats: {},
    },
    base(),
    '기타',
  );
  assert.deepEqual(groups.map((g) => [g.name, g.state]), [['web', 'down'], ['db', 'warn']]);
  const web = groups[0]!;
  // web-01은 worker DOWN, web-02는 CPU 97(위험). DOWN이 더 나쁘다.
  assert.deepEqual(web.items.map((i) => [i.name, i.state]), [['web-01', 'down'], ['web-02', 'crit']]);
  assert.deepEqual(web.counts, { down: 1, crit: 1, warn: 0, ok: 0, unknown: 0 });
  assert.equal(web.servicesUp, 1);
  assert.equal(web.servicesTotal, 2);
  // 내려간 서비스가 먼저
  assert.deepEqual(web.items[0]!.services.map((x) => [x.name, x.up]), [['worker', false], ['nginx', true]]);
  assert.deepEqual(web.items[1]!.metrics.map((m) => [m.key, m.value, m.state]), [['cpu', 97, 'crit'], ['disk', 41, 'ok']]);
});

test('설정의 groups 이름 패턴이 job보다 먼저다', () => {
  const cfg = { ...base(), groups: { '운영 웹': ['web-*'] } };
  const groups = buildGroups({ metrics: { cpu: [s('web-01:9100', 'node', 10), s('mail:9100', 'node', 10)] }, services: [], stats: {} }, cfg, '기타');
  assert.deepEqual(groups.map((g) => g.name).sort(), ['node', '운영 웹']);
});

test('업무 지표는 설정의 그룹·대상에 붙고, 낮을수록 나쁜 지표도 판정한다', () => {
  const cfg = {
    ...base(),
    stats: [
      { group: '쇼핑몰', item: '오늘', key: 'orders', label: '주문', unit: '건', query: 'x', warn: 500, crit: 200, lowerIsWorse: true },
      { group: '쇼핑몰', item: '오늘', key: 'returns', label: '반품', unit: '건', query: 'y', warn: 50, crit: 100 },
      { group: '쇼핑몰', item: '오늘', key: 'none', label: '없음', unit: '', query: 'z' },
    ],
  };
  const groups = buildGroups({ metrics: {}, services: [], stats: { orders: 180, returns: 37 } }, cfg, '기타');
  assert.equal(groups.length, 1);
  const shop = groups[0]!;
  assert.equal(shop.name, '쇼핑몰');
  assert.equal(shop.items[0]!.name, '오늘');
  // 주문 180건은 200 이하라 위험, 반품 37건은 정상. 값이 없는 지표는 빠진다.
  assert.deepEqual(shop.items[0]!.metrics.map((m) => [m.label, m.value, m.state]), [['주문', 180, 'crit'], ['반품', 37, 'ok']]);
  assert.equal(shop.state, 'crit');
});

test('판정·포트 떼기', () => {
  const [cpu] = defaultMetrics();
  assert.equal(judge(cpu!, 79.9), 'ok');
  assert.equal(judge(cpu!, 80), 'warn');
  assert.equal(judge(cpu!, 95), 'crit');
  assert.equal(stripPort('web-01:9100'), 'web-01');
  assert.equal(stripPort('[::1]:9100'), '::1');
  assert.equal(stripPort('10.0.0.5'), '10.0.0.5');
});

test('Grafana 데이터 프레임에서 라벨과 마지막 값을 읽는다', () => {
  const series = framesToSeries([
    {
      schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels: { instance: 'a:9100', job: 'node' } }] },
      data: { values: [[1, 2], [10, 12.5]] },
    },
    { schema: { fields: [{ name: 'count', type: 'number' }] }, data: { values: [[37]] } },
  ]);
  assert.deepEqual(series, [
    { labels: { instance: 'a:9100', job: 'node' }, value: 12.5 },
    { labels: {}, value: 37 },
  ]);
});

test('GrafanaSource: 기본 Prometheus를 찾고, 쿼리를 한 번에 보내고, 업무 지표 하나가 실패해도 나머지는 읽는다', async () => {
  const calls: Array<{ url: string; body?: unknown; auth?: string }> = [];
  const frame = (labels: Record<string, string>, v: number) => ({
    schema: { fields: [{ type: 'time' }, { type: 'number', labels }] },
    data: { values: [[0], [v]] },
  });
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
    if (url.endsWith('/api/datasources')) {
      return new Response(JSON.stringify([{ uid: 'loki', type: 'loki' }, { uid: 'p1', type: 'prometheus' }, { uid: 'p2', type: 'prometheus', isDefault: true }]));
    }
    return new Response(
      JSON.stringify({
        results: {
          m_cpu: { frames: [frame({ instance: 'web-01:9100', job: 'web' }, 42)] },
          m_disk: { frames: [] },
          m_mem: { frames: [] },
          services: { frames: [frame({ instance: 'web-01:9100', job: 'nginx' }, 1)] },
          s_orders: { frames: [{ schema: { fields: [{ type: 'number' }] }, data: { values: [[1284]] } }] },
          s_returns: { error: 'table not found' },
        },
      }),
    );
  }) as typeof fetch;

  const cfg: Cfg = {
    ...base(),
    mode: 'grafana',
    grafana: { url: 'http://g', token: 'glsa_x', datasourceUid: '' },
    stats: [
      { group: '쇼핑몰', item: '오늘', key: 'orders', label: '주문', unit: '건', query: 'sum(x)' },
      { group: '쇼핑몰', item: '오늘', key: 'returns', label: '반품', unit: '건', query: '', datasourceUid: 'mysql', sql: 'SELECT 1' },
    ],
  };
  const sample = await new GrafanaSource(fakeFetch).sample(cfg);
  assert.equal(calls[0]!.url, 'http://g/api/datasources');
  assert.equal(calls[1]!.auth, 'Bearer glsa_x');
  const queries = (calls[1]!.body as { queries: Array<Record<string, unknown>> }).queries;
  assert.deepEqual(queries.find((q) => q.refId === 'm_cpu')?.datasource, { uid: 'p2' }, '기본 Prometheus를 쓴다');
  const sql = queries.find((q) => q.refId === 's_returns')!;
  assert.equal(sql.rawSql, 'SELECT 1');
  assert.deepEqual(sql.datasource, { uid: 'mysql' });
  assert.equal(sample.metrics.cpu![0]!.value, 42);
  assert.deepEqual(sample.stats, { orders: 1284, returns: undefined });
});

test('Monitor: 켜자마자 나빠 있던 것은 알리지 않고, 나빠질 때와 나아질 때 한 번씩 알린다', async () => {
  let cpu = 97;
  const source = {
    name: 'fake',
    sample: async () => ({ metrics: { cpu: [s('web-01:9100', 'web', cpu)], disk: [], mem: [] }, services: [], stats: {} }),
  };
  const before = notifications.list().length;
  const m = new Monitor({ ...base(), mode: 'grafana' }, source);
  let snap = await m.refresh();
  assert.equal(snap.state, 'crit');
  assert.equal(notifications.list().length, before, '처음 읽은 상태는 기준만 잡는다');

  cpu = 30;
  await m.refresh();
  assert.match(notifications.list()[0]!.title, /web-01 복구/);
  cpu = 99;
  snap = await m.refresh();
  assert.match(notifications.list()[0]!.title, /web-01 위험/);
  assert.match(notifications.list()[0]!.body, /CPU 99%/);
  await m.refresh();
  assert.equal(notifications.list().length, before + 2, '나쁜 채로 이어지면 다시 알리지 않는다');
  assert.equal(snap.counts.crit, 1);
});

test('Monitor: 조회가 실패하면 그 전 값을 두고 stale·error를 싣는다', async () => {
  let fail = false;
  const source = {
    name: 'fake',
    sample: async () => {
      if (fail) throw new Error('Grafana /api/ds/query 502');
      return { metrics: { cpu: [s('web-01:9100', 'web', 10)], disk: [], mem: [] }, services: [], stats: {} };
    },
  };
  const m = new Monitor({ ...base(), mode: 'grafana' }, source);
  await m.refresh();
  fail = true;
  const snap = await m.refresh();
  assert.equal(snap.stale, true);
  assert.match(snap.error ?? '', /502/);
  assert.equal(snap.groups[0]!.items[0]!.name, 'web-01');
});

test('Monitor: 값만 흔들리면 monitor 이벤트를 다시 보내지 않고, 상태가 바뀌면 보낸다', async () => {
  const { subscribe } = await import('../src/core/events.js');
  let cpu = 10;
  const source = {
    name: 'fake',
    sample: async () => ({ metrics: { cpu: [s('web-01:9100', 'web', cpu)], disk: [], mem: [] }, services: [], stats: {} }),
  };
  const seen: string[] = [];
  const off = subscribe((topic) => seen.push(topic));
  const m = new Monitor({ ...base(), mode: 'grafana' }, source);
  await m.refresh();
  cpu = 20;
  await m.refresh();
  cpu = 30;
  await m.refresh();
  assert.equal(seen.filter((t) => t === 'monitor').length, 1, '처음 한 번만');
  cpu = 85;
  await m.refresh();
  assert.equal(seen.filter((t) => t === 'monitor').length, 2, '주의로 바뀌면 알린다');
  off();
});

test('설정: GRAFANA_URL이 있으면 grafana, 없으면 off. 파일은 덮어쓰되 토큰은 환경변수만', () => {
  assert.equal(loadMonitorConfig({}).mode, 'off');
  assert.equal(loadMonitorConfig({ GRAFANA_URL: 'http://g/' }).grafana.url, 'http://g');
  assert.equal(loadMonitorConfig({ GRAFANA_URL: 'http://g' }).mode, 'grafana');
  const file = path.join(process.env.RELAY_DATA_DIR!, 'monitor.json');
  fs.writeFileSync(file, JSON.stringify({ groupLabel: 'env', refreshSeconds: 3, grafana: { token: 'nope' } }));
  const cfg = loadMonitorConfig({ GRAFANA_URL: 'http://g', GRAFANA_TOKEN: 'real', RELAY_MONITOR_CONFIG: file });
  assert.equal(cfg.groupLabel, 'env');
  assert.equal(cfg.refreshSeconds, 10, '너무 잦은 조회는 10초로 올린다');
  assert.equal(cfg.grafana.token, 'real');
  // 가짜 데이터는 설정 파일이 없으면 쇼핑몰 예시를 단다.
  assert.ok(loadMonitorConfig({ RELAY_MONITOR: 'demo' }).stats.some((x) => x.key === 'orders'));
});

test('가짜 원자료로 그룹 넷(웹·DB·스테이징·쇼핑몰)이 나오고 문제 있는 것이 섞여 있다', async () => {
  const cfg = loadMonitorConfig({ RELAY_MONITOR: 'demo' });
  const groups = buildGroups(await new DemoSource(() => 0).sample(cfg), cfg, '기타');
  assert.equal(groups.length, 4);
  assert.equal(groups[0]!.state, 'down', 'web-03 worker DOWN');
  assert.ok(groups.some((g) => g.items.some((i) => i.metrics.some((m) => m.key === 'returns'))));
});
