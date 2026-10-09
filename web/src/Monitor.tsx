import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type MetricDef,
  type MonitorConfigReply,
  type MonitorGroup,
  type MonitorMetric,
  type MonitorMode,
  type MonitorSettingsInput,
  type MonitorSnapshot,
  type MonitorState,
  type MonitorTrial,
} from './api.js';
import { formatDateTime, msg } from './i18n.js';

/**
 * 모니터링(Grafana). 상태는 relay가 모은 그룹 → 대상 → 지표·서비스를 그대로 보이고,
 * 설정은 Grafana 연결·서버 묶기·지표·업무 지표를 바꿔 저장한다(data/monitor.json).
 * 저장하면 relay가 바로 다시 읽고, 안경·폰도 같은 값을 받는다.
 */
export function Monitor({ onToast }: { onToast: (m: string, e?: boolean) => void }) {
  const t = msg();
  const [view, setView] = useState<'status' | 'settings'>('status');
  return (
    <div className="mon">
      <div className="tabs mon-tabs">
        <button className={view === 'status' ? 'active' : ''} onClick={() => setView('status')}>
          {t.monStatus}
        </button>
        <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
          {t.monSettings}
        </button>
      </div>
      {view === 'status' ? <MonitorStatus onToast={onToast} /> : <MonitorSettings onToast={onToast} />}
    </div>
  );
}

// --- 상태 ---

const MARK: Record<MonitorState, string> = { down: '■', crit: '■', warn: '▲', ok: '●', unknown: '○' };

function Mark({ state }: { state: MonitorState }) {
  return <span className={`mon-mark ${state}`}>{MARK[state]}</span>;
}

/** 1248 → 1,248. 10보다 작으면 소수 한 자리. 안경·폰과 같은 규칙이다. */
function formatValue(m: MonitorMetric): string {
  const v = Math.abs(m.value) >= 10 ? Math.round(m.value) : Math.round(m.value * 10) / 10;
  return `${v.toLocaleString('en-US')}${m.unit}`;
}

function MonitorStatus({ onToast }: { onToast: (m: string, e?: boolean) => void }) {
  const t = msg();
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnap(await api.getMonitor());
    } catch (err) {
      onToast((err as Error).message, true);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
    // relay와 같은 주기로 맞춘다.
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      setSnap(await api.refreshMonitor());
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  if (!snap) return <div className="empty">{t.monLoading}</div>;
  if (!snap.enabled) return <div className="empty">{t.monOff}</div>;

  const servicesUp = snap.groups.reduce((a, g) => a + g.servicesUp, 0);
  const servicesTotal = snap.groups.reduce((a, g) => a + g.servicesTotal, 0);
  return (
    <div className="mon-body">
      <div className="mon-summary">
        <Mark state={snap.state} />
        <span className={`mon-count ${snap.counts.down + snap.counts.crit > 0 ? 'bad' : ''}`}>
          <b>{snap.counts.down + snap.counts.crit}</b> {t.monProblem}
        </span>
        <span className={`mon-count ${snap.counts.warn > 0 ? 'warn' : ''}`}>
          <b>{snap.counts.warn}</b> {t.monWarn}
        </span>
        <span className="mon-count ok">
          <b>{snap.counts.ok}</b> {t.monOk}
        </span>
        {servicesTotal > 0 && <span className="badge">{t.monServices(servicesUp, servicesTotal)}</span>}
        <span className="spacer" />
        {snap.updatedAt && <span className="mon-dim">{t.monAsOf(formatDateTime(snap.updatedAt))}</span>}
        <span className="badge">{t.monSource(snap.source)}</span>
        <button onClick={() => void refresh()} disabled={busy}>
          ↻ {t.monRefresh}
        </button>
      </div>
      {snap.stale && (
        <div className="mon-alert">
          {t.monStale}
          {snap.error ? ` · ${snap.error}` : ''}
        </div>
      )}
      {snap.groups.length === 0 && <div className="empty">{snap.error ?? t.monEmpty}</div>}
      <div className="mon-groups">
        {snap.groups.map((g) => (
          <GroupCard key={g.id} group={g} />
        ))}
      </div>
    </div>
  );
}

function GroupCard({ group: g }: { group: MonitorGroup }) {
  const t = msg();
  return (
    <section className="mon-group">
      <header>
        <Mark state={g.state} />
        <b>{g.name}</b>
        <span className="spacer" />
        {g.servicesTotal > 0 && <span className="mon-dim">{t.monServices(g.servicesUp, g.servicesTotal)}</span>}
      </header>
      {g.items.map((i) => (
        <div key={i.id} className={`mon-item ${i.state}`}>
          <div className="mon-item-head">
            <Mark state={i.state} />
            <span className="mon-item-name">{i.name}</span>
          </div>
          <div className="mon-metrics">
            {i.metrics.map((m) => (
              <div key={m.key} className={`mon-metric ${m.state}`} title={m.key}>
                <span className="mon-metric-label">{m.label}</span>
                <span className="mon-metric-value">{formatValue(m)}</span>
                {m.max !== undefined && m.max > 0 && (
                  <span className="mon-bar">
                    <span style={{ width: `${Math.min(100, Math.max(0, (m.value / m.max) * 100))}%` }} />
                  </span>
                )}
              </div>
            ))}
          </div>
          {i.services.length > 0 && (
            <div className="mon-services">
              {[...i.services]
                .sort((a, b) => Number(a.up) - Number(b.up))
                .map((s) => (
                  <span key={s.name} className={`mon-svc ${s.up ? 'up' : 'down'}`}>
                    {s.up ? '●' : '■'} {s.name}
                  </span>
                ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// --- 설정 ---

/** 숫자 칸은 글로 들고 있다가 보낼 때 바꾼다. 비우면 없음. */
interface Row {
  key: string;
  label: string;
  query: string;
  unit: string;
  max: string;
  warn: string;
  crit: string;
  lowerIsWorse: boolean;
  group: string;
  item: string;
  useSql: boolean;
  sql: string;
  datasourceUid: string;
}

interface Draft {
  mode: MonitorMode;
  url: string;
  token: string;
  clearToken: boolean;
  datasourceUid: string;
  refreshSeconds: string;
  serverLabel: string;
  stripPort: boolean;
  groupLabel: string;
  groupsText: string;
  metrics: Row[];
  servicesQuery: string;
  servicesName: string;
  stats: Row[];
}

const n2s = (v: number | undefined): string => (v === undefined ? '' : String(v));
const s2n = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

function toRow(m: MetricDef): Row {
  return {
    key: m.key,
    label: m.label,
    query: m.query ?? '',
    unit: m.unit ?? '',
    max: n2s(m.max),
    warn: n2s(m.warn),
    crit: n2s(m.crit),
    lowerIsWorse: m.lowerIsWorse === true,
    group: m.group ?? '',
    item: m.item ?? '',
    useSql: !!m.sql,
    sql: m.sql ?? '',
    datasourceUid: m.datasourceUid ?? '',
  };
}

function fromRow(r: Row, stat: boolean): MetricDef {
  const m: MetricDef = {
    key: r.key.trim(),
    label: r.label.trim(),
    query: stat && r.useSql ? '' : r.query.trim(),
    unit: r.unit,
    max: s2n(r.max),
    warn: s2n(r.warn),
    crit: s2n(r.crit),
    lowerIsWorse: r.lowerIsWorse || undefined,
  };
  if (stat) {
    m.group = r.group.trim();
    m.item = r.item.trim();
    if (r.useSql) m.sql = r.sql.trim();
    if (r.datasourceUid.trim()) m.datasourceUid = r.datasourceUid.trim();
  }
  return m;
}

function toDraft(c: MonitorConfigReply): Draft {
  const e = c.effective;
  return {
    mode: e.mode,
    url: e.grafana.url,
    token: '',
    clearToken: false,
    datasourceUid: e.grafana.datasourceUid,
    refreshSeconds: String(e.refreshSeconds),
    serverLabel: e.serverLabel,
    stripPort: e.stripPort,
    groupLabel: e.groupLabel,
    groupsText: Object.entries(e.groups)
      .map(([name, pats]) => `${name} = ${pats.join(', ')}`)
      .join('\n'),
    metrics: e.metrics.map(toRow),
    servicesQuery: e.services?.query ?? '',
    servicesName: e.services?.nameLabel ?? 'job',
    stats: e.stats.map(toRow),
  };
}

/** '운영 웹 = web-*, api-*' 줄들 → { '운영 웹': ['web-*', 'api-*'] } */
function parseGroups(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at < 0) continue;
    const name = line.slice(0, at).trim();
    const pats = line
      .slice(at + 1)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (name && pats.length) out[name] = pats;
  }
  return out;
}

function toInput(d: Draft): MonitorSettingsInput {
  return {
    mode: d.mode,
    refreshSeconds: Number(d.refreshSeconds) || 30,
    grafana: { url: d.url.trim(), datasourceUid: d.datasourceUid.trim(), ...(d.token.trim() ? { token: d.token.trim() } : {}) },
    clearToken: d.clearToken || undefined,
    serverLabel: d.serverLabel,
    stripPort: d.stripPort,
    groupLabel: d.groupLabel,
    groups: parseGroups(d.groupsText),
    metrics: d.metrics.map((r) => fromRow(r, false)),
    services: d.servicesQuery.trim() ? { query: d.servicesQuery.trim(), nameLabel: d.servicesName.trim() || 'job' } : null,
    stats: d.stats.map((r) => fromRow(r, true)),
  };
}

const emptyRow = (stat: boolean): Row => ({
  key: '',
  label: '',
  query: '',
  unit: stat ? '' : '%',
  max: stat ? '' : '100',
  warn: '',
  crit: '',
  lowerIsWorse: false,
  group: '',
  item: '',
  useSql: false,
  sql: '',
  datasourceUid: '',
});

function MonitorSettings({ onToast }: { onToast: (m: string, e?: boolean) => void }) {
  const t = msg();
  const [conf, setConf] = useState<MonitorConfigReply | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [trial, setTrial] = useState<MonitorTrial | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api.getMonitorConfig();
      setConf(c);
      setD(toDraft(c));
      setTrial(null);
    } catch (err) {
      onToast((err as Error).message, true);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!conf || !d) return <div className="empty">{t.monLoading}</div>;
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const setRow = (list: 'metrics' | 'stats', i: number, patch: Partial<Row>) =>
    set({ [list]: d[list].map((r, j) => (j === i ? { ...r, ...patch } : r)) } as Partial<Draft>);
  const removeRow = (list: 'metrics' | 'stats', i: number) =>
    set({ [list]: d[list].filter((_, j) => j !== i) } as Partial<Draft>);

  async function test(): Promise<void> {
    if (!d) return;
    setBusy(true);
    setTrial(null);
    try {
      setTrial(await api.testMonitorConfig(toInput(d)));
    } catch (err) {
      setTrial({ ok: false, error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!d) return;
    setBusy(true);
    try {
      await api.saveMonitorConfig(toInput(d));
      onToast(t.monSaved);
      await load();
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const locked = conf.locks;
  const grafana = d.mode === 'grafana';
  const tokenPlaceholder = conf.tokenFrom === 'env' ? t.monTokenEnv : conf.tokenFrom === 'saved' ? t.monTokenSaved : '';
  const trialItems = trial?.groups?.reduce((a, g) => a + g.items.length, 0) ?? 0;

  return (
    <div className="mon-body mon-settings">
      <section>
        <h3>{t.monConnection}</h3>
        <div className="mon-grid">
          <div className="field">
            <label>{t.monMode}</label>
            <select value={d.mode} disabled={locked.mode} onChange={(e) => set({ mode: e.target.value as MonitorMode })}>
              <option value="grafana">{t.monModeGrafana}</option>
              <option value="demo">{t.monModeDemo}</option>
              <option value="off">{t.monModeOff}</option>
            </select>
            {locked.mode && <span className="hint">{t.monLocked}</span>}
          </div>
          <div className="field">
            <label>{t.monRefreshSeconds}</label>
            <input type="number" min={10} value={d.refreshSeconds} onChange={(e) => set({ refreshSeconds: e.target.value })} />
          </div>
        </div>
        {grafana && (
          <>
            <div className="field">
              <label>{t.monUrl}</label>
              <input
                value={d.url}
                disabled={locked.url}
                placeholder="http://grafana:3000"
                onChange={(e) => set({ url: e.target.value })}
              />
              {locked.url && <span className="hint">{t.monLocked}</span>}
            </div>
            <div className="field">
              <label>{t.monToken}</label>
              <input
                type="password"
                autoComplete="new-password"
                value={d.token}
                disabled={locked.token}
                placeholder={tokenPlaceholder}
                onChange={(e) => set({ token: e.target.value, clearToken: false })}
              />
              <span className="hint">{t.monTokenHint}</span>
              {conf.tokenFrom === 'saved' && (
                <label className="mon-check">
                  <input type="checkbox" checked={d.clearToken} onChange={(e) => set({ clearToken: e.target.checked, token: '' })} />
                  {t.monTokenClear}
                </label>
              )}
            </div>
            <div className="field">
              <label>{t.monDatasource}</label>
              <input
                value={d.datasourceUid}
                disabled={locked.datasourceUid}
                onChange={(e) => set({ datasourceUid: e.target.value })}
              />
              <span className="hint">{locked.datasourceUid ? t.monLocked : t.monDatasourceHint}</span>
            </div>
          </>
        )}
      </section>

      <section>
        <h3>{t.monGrouping}</h3>
        <div className="mon-grid">
          <div className="field">
            <label>{t.monServerLabel}</label>
            <input value={d.serverLabel} onChange={(e) => set({ serverLabel: e.target.value })} />
            <label className="mon-check">
              <input type="checkbox" checked={d.stripPort} onChange={(e) => set({ stripPort: e.target.checked })} />
              {t.monStripPort}
            </label>
          </div>
          <div className="field">
            <label>{t.monGroupLabel}</label>
            <input value={d.groupLabel} onChange={(e) => set({ groupLabel: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label>{t.monGroupsText}</label>
          <textarea
            rows={3}
            className="mono"
            value={d.groupsText}
            placeholder={'운영 웹 = web-*\nDB = db-*'}
            onChange={(e) => set({ groupsText: e.target.value })}
          />
          <span className="hint">{t.monGroupsHint}</span>
        </div>
      </section>

      <section>
        <h3>{t.monMetrics}</h3>
        <p className="hint">{t.monMetricsHint}</p>
        {d.metrics.map((r, i) => (
          <MetricRow key={i} row={r} stat={false} onChange={(p) => setRow('metrics', i, p)} onRemove={() => removeRow('metrics', i)} />
        ))}
        <div className="mon-row-actions">
          <button onClick={() => set({ metrics: [...d.metrics, emptyRow(false)] })}>＋ {t.monAddMetric}</button>
          <button className="ghost" onClick={() => set({ metrics: conf.defaults.metrics.map(toRow) })}>
            {t.monResetMetrics}
          </button>
        </div>
      </section>

      <section>
        <h3>{t.monServicesSection}</h3>
        <div className="mon-grid">
          <div className="field">
            <label>{t.monServicesQuery}</label>
            <input className="mono" value={d.servicesQuery} onChange={(e) => set({ servicesQuery: e.target.value })} />
          </div>
          <div className="field">
            <label>{t.monServicesName}</label>
            <input value={d.servicesName} onChange={(e) => set({ servicesName: e.target.value })} />
          </div>
        </div>
      </section>

      <section>
        <h3>{t.monStats}</h3>
        <p className="hint">{t.monStatsHint}</p>
        {d.stats.map((r, i) => (
          <MetricRow key={i} row={r} stat onChange={(p) => setRow('stats', i, p)} onRemove={() => removeRow('stats', i)} />
        ))}
        <div className="mon-row-actions">
          <button onClick={() => set({ stats: [...d.stats, emptyRow(true)] })}>＋ {t.monAddStat}</button>
        </div>
      </section>

      {trial && (
        <section className={`mon-trial ${trial.ok ? 'ok' : 'fail'}`}>
          <b>{trial.ok ? t.monTestOk(trial.groups?.length ?? 0, trialItems) : t.monTestFail}</b>
          {trial.error && <div className="mono">{trial.error}</div>}
          {trial.groups && trial.groups.length > 0 && (
            <div className="mon-trial-groups">
              {trial.groups.map((g) => (
                <div key={g.id}>
                  <Mark state={g.state} /> {g.name}: {g.items.map((x) => x.name).join(', ')}
                </div>
              ))}
            </div>
          )}
          {trial.datasources && trial.datasources.length > 0 && !locked.datasourceUid && (
            <div className="mon-trial-ds">
              {trial.datasources.map((ds) => (
                <div key={ds.uid}>
                  <span className="mono">{ds.uid}</span> · {ds.name} <span className="badge">{ds.type}</span>
                  {ds.isDefault && <span className="badge">default</span>}{' '}
                  {ds.type !== 'prometheus' ? (
                    // 서버 지표는 Prometheus 쿼리라 다른 종류는 고를 수 없다. 업무 지표에서 쓴다.
                    <span className="hint">{t.monDatasourceForStats}</span>
                  ) : d.datasourceUid === ds.uid ? (
                    <span className="badge mon-picked">✓ {t.monDatasourcePicked}</span>
                  ) : (
                    <button
                      onClick={() => {
                        set({ datasourceUid: ds.uid });
                        onToast(t.monDatasourceSet(ds.uid));
                      }}
                    >
                      {t.monPickDatasource}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="mon-footer">
        <span className="hint">{t.monFiles(conf.settingsFile)}</span>
        <span className="spacer" />
        <button className="ghost" onClick={() => void load()} disabled={busy}>
          {t.monReload}
        </button>
        <button onClick={() => void test()} disabled={busy || d.mode === 'off'}>
          {busy ? t.monTesting : t.monTest}
        </button>
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {t.monSave}
        </button>
      </div>
    </div>
  );
}

/** 지표 한 줄. 업무 지표면 그룹·대상·SQL·데이터 소스 칸이 더 붙는다. */
function MetricRow({
  row: r,
  stat,
  onChange,
  onRemove,
}: {
  row: Row;
  stat: boolean;
  onChange: (p: Partial<Row>) => void;
  onRemove: () => void;
}) {
  const t = msg();
  return (
    <div className="mon-def">
      <div className="mon-def-line">
        {stat && (
          <>
            <Mini label={t.monGroup}>
              <input value={r.group} onChange={(e) => onChange({ group: e.target.value })} />
            </Mini>
            <Mini label={t.monItem}>
              <input value={r.item} onChange={(e) => onChange({ item: e.target.value })} />
            </Mini>
          </>
        )}
        <Mini label={t.monKey}>
          <input value={r.key} onChange={(e) => onChange({ key: e.target.value })} />
        </Mini>
        <Mini label={t.monLabel}>
          <input value={r.label} onChange={(e) => onChange({ label: e.target.value })} />
        </Mini>
        <Mini label={t.monUnit} narrow>
          <input value={r.unit} onChange={(e) => onChange({ unit: e.target.value })} />
        </Mini>
        <Mini label={t.monMax} narrow>
          <input type="number" value={r.max} onChange={(e) => onChange({ max: e.target.value })} />
        </Mini>
        <Mini label={t.monWarnAt} narrow>
          <input type="number" value={r.warn} onChange={(e) => onChange({ warn: e.target.value })} />
        </Mini>
        <Mini label={t.monCritAt} narrow>
          <input type="number" value={r.crit} onChange={(e) => onChange({ crit: e.target.value })} />
        </Mini>
        <label className="mon-check">
          <input type="checkbox" checked={r.lowerIsWorse} onChange={(e) => onChange({ lowerIsWorse: e.target.checked })} />
          {t.monLowerIsWorse}
        </label>
        <button className="ghost danger" onClick={onRemove} title={t.monRemove}>
          ✕
        </button>
      </div>
      {stat && (
        <div className="mon-def-line">
          <label className="mon-check">
            <input type="checkbox" checked={r.useSql} onChange={(e) => onChange({ useSql: e.target.checked })} />
            {t.monUseSql}
          </label>
          <Mini label={t.monDatasource}>
            <input value={r.datasourceUid} onChange={(e) => onChange({ datasourceUid: e.target.value })} />
          </Mini>
        </div>
      )}
      {stat && r.useSql ? (
        <textarea className="mono" rows={2} placeholder={t.monSql} value={r.sql} onChange={(e) => onChange({ sql: e.target.value })} />
      ) : (
        <textarea className="mono" rows={2} placeholder={t.monQuery} value={r.query} onChange={(e) => onChange({ query: e.target.value })} />
      )}
    </div>
  );
}

/** 지표 줄의 작은 칸. 위에 이름을 단다 — 숫자만 있으면 100·80·95가 무엇인지 모른다. */
function Mini({ label, narrow, children }: { label: string; narrow?: boolean; children: React.ReactNode }) {
  return (
    <label className={`mon-mini${narrow ? ' narrow' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
