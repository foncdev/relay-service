import { memo, useCallback, useEffect, useState } from 'react';
import { api, ApiError, type TerminalInfo } from './api.js';
import { TerminalView } from './Terminal.js';
import { ConfirmModal, useToast } from './ui.js';
import { msg } from './i18n.js';

/**
 * 터미널 탭.
 *
 * 맥에서 terminal-agent가 돌고 있으면 그 콘솔과 같은 셸이 여기 보인다.
 * 새 터미널을 열 수도 있다 — 그건 맥 화면에는 안 뜨고 웹에만 있는다.
 */
export const Terminals = memo(TerminalsInner);

/**
 * memo로 감싸는 이유.
 *
 * App이 5초마다 세션 목록을 갱신하는데, 그때마다 이 컴포넌트까지 다시
 * 그려지면 xterm이 포커스를 잃어 타이핑이 끊긴다. props가 그대로면
 * 다시 그리지 않는다.
 */
function TerminalsInner({ agentMissing }: { agentMissing?: boolean }) {
  const t = msg();
  const [toastNode, toast] = useToast();

  const [list, setList] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmClose, setConfirmClose] = useState<TerminalInfo | null>(null);
  /**
   * 한 번이라도 agent가 붙어 있었는지.
   *
   * 처음부터 안 떠 있는 것과, 쓰던 중에 끊긴 것은 다른 상황이다.
   * 맥에서 exit하면 서버가 함께 종료되므로 후자가 자주 일어난다.
   */
  const [wasConnected, setWasConnected] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { terminals } = await api.listTerminals();

      // 내용이 같으면 기존 배열을 그대로 둔다.
      //
      // 5초마다 새 객체로 바꾸면 TerminalView가 매번 다시 마운트되고,
      // 그때 xterm이 포커스를 잃어 타이핑이 끊긴다.
      setList((cur) => (sameList(cur, terminals) ? cur : terminals));
      setError('');
      setWasConnected(true);

      // 고른 게 없거나 사라졌으면 첫 번째를 고른다.
      setActiveId((cur) => {
        if (cur && terminals.some((t) => t.id === cur)) return cur;
        return terminals[0]?.id ?? '';
      });
    } catch (e) {
      const text =
        e instanceof ApiError && e.code === 'no_agent'
          ? msg().noTerminalAgent
          : e instanceof Error
            ? e.message
            : msg().loadTerminalsFailed;
      setError(text);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 맥에서 새 터미널이 생길 수도 있으니 가끔 확인한다.
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const create = async () => {
    try {
      // 실제 크기는 화면이 붙은 뒤 알려준다. 여기서는 무난한 값을 쓴다.
      const { terminal } = await api.createTerminal({ cols: 100, rows: 30 });
      setList((cur) => [...cur, terminal]);
      setActiveId(terminal.id);
      toast(t.terminalOpened);
    } catch (e) {
      toast(e instanceof Error ? e.message : t.openTerminalFailed);
    }
  };

  const close = async (t: TerminalInfo) => {
    try {
      await api.closeTerminal(t.id);
      setList((cur) => cur.filter((x) => x.id !== t.id));
      toast(msg().terminalClosed);
      void refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : msg().closeTerminalFailed);
    }
  };

  // 매 렌더마다 새 함수를 만들면 TerminalView가 다시 마운트된다.
  const handleExit = useCallback(() => void refresh(), [refresh]);

  const active = list.find((t) => t.id === activeId);

  if (loading) {
    return <div className="empty">{t.loading}</div>;
  }

  if (error || agentMissing) {
    const disconnected = wasConnected;
    return (
      <div className="empty term-empty">
        {disconnected ? (
          <>
            <p className="term-lost">{t.disconnected}</p>
            <p className="term-lost-why">
              {t.disconnectedWhy[0]}
              <code>exit</code>
              {t.disconnectedWhy[1]}
              <code>ctrl+\</code>
              {t.disconnectedWhy[2]}
            </p>
          </>
        ) : (
          <p>{error || t.noTerminalAgent}</p>
        )}
        <pre className="hint">
{`${t.restartOnMac}
  cd terminal-agent
  make run`}
        </pre>
        <button onClick={() => void refresh()}>{t.reconnect}</button>
        {toastNode}
      </div>
    );
  }

  return (
    <div className="terminals">
      <div className="term-tabs">
        {list.map((t) => (
          <button
            key={t.id}
            className={t.id === activeId ? 'active' : ''}
            onClick={() => setActiveId(t.id)}
            title={t.dir}
          >
            <span className={`dot ${t.status}`} />
            {shortDir(t.dir)}
            <span className="term-size">
              {t.cols}×{t.rows}
            </span>
          </button>
        ))}
        <button className="term-new" onClick={() => void create()}>
          {t.newTerminal}
        </button>
        <span className="spacer" />
        {active && (
          <button className="danger" onClick={() => setConfirmClose(active)}>
            {t.close}
          </button>
        )}
      </div>

      {active ? (
        // key를 주어 터미널이 바뀌면 화면을 새로 만든다.
        <TerminalView key={active.id} terminal={active} onExit={handleExit} />
      ) : (
        <div className="empty">
          <p>{t.noTerminals}</p>
          <button onClick={() => void create()}>{t.openTerminal}</button>
        </div>
      )}

      {confirmClose && (
        <ConfirmModal
          title={t.closeTerminal}
          message={t.closeTerminalQ(shortDir(confirmClose.dir))}
          confirmLabel={t.close}
          danger
          onConfirm={() => {
            void close(confirmClose);
            setConfirmClose(null);
          }}
          onClose={() => setConfirmClose(null)}
        />
      )}
      {toastNode}
    </div>
  );
}

/**
 * 목록이 실질적으로 같은지 본다.
 *
 * 폴링 응답은 매번 새 객체라 그대로 넣으면 React가 바뀐 줄 안다.
 * 화면에 쓰는 값만 비교해서, 같으면 기존 것을 유지한다.
 */
function sameList(a: TerminalInfo[], b: TerminalInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.id === y.id &&
      x.status === y.status &&
      x.cols === y.cols &&
      x.rows === y.rows &&
      x.dir === y.dir
    );
  });
}

/** 경로가 길면 뒤쪽 두 칸만 보여준다. 탭이 좁기 때문이다. */
function shortDir(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  if (parts.length <= 2) return dir;
  return '…/' + parts.slice(-2).join('/');
}
