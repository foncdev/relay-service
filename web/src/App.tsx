import { useCallback, useEffect, useState } from 'react';
import { BANNER } from './banner.js';
import { Login } from './Login.js';
import {
  api,
  ApiError,
  getToken,
  setToken,
  SIGNED_OUT_EVENT,
  TOKEN_STORAGE,
  getApiKey,
  getDeleteOriginalOnResume,
  setApiKey,
  setDeleteOriginalOnResume,
  type PolicyMode,
  type SessionInfo,
  type Workspace,
} from './api.js';
import { Chat } from './Chat.js';
import { Notifications } from './Notifications.js';
import { Monitor } from './Monitor.js';
import { Checklist } from './Checklist.js';
import { Terminals } from './Terminals.js';
import { Files } from './Files.js';
import { ConfirmModal, Modal, PromptModal, formatTime, useToast } from './ui.js';
import { msg } from './i18n.js';

/**
 * 세션 목록이 실질적으로 같은지 본다.
 *
 * 폴링 응답은 매번 새 객체다. 그대로 넣으면 React가 바뀐 줄 알고
 * 전체를 다시 그린다. 화면에 쓰는 값만 비교한다.
 */
function sameSessions(a: SessionInfo[], b: SessionInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    // y가 없을 수 있다. 길이는 같아도 폴링 사이에 배열이 바뀔 수 있다.
    if (!y) return false;
    return (
      x.id === y.id &&
      x.status === y.status &&
      x.title === y.title &&
      x.live === y.live &&
      x.turns === y.turns &&
      // 권한 요청이 없으면 서버가 이 필드를 아예 빼고 보낸다.
      // 그대로 .length를 읽으면 폴링 때마다 App이 통째로 죽는다.
      (x.pending?.length ?? 0) === (y.pending?.length ?? 0) &&
      x.lastActivityAt === y.lastActivityAt
    );
  });
}

type Tab = 'sessions' | 'files' | 'term' | 'todo' | 'notif' | 'monitor';

export function App() {
  const t = msg();
  const [toastNode, toast] = useToast();
  /** 로그인 여부. 토큰이 있으면 이미 로그인한 상태로 본다. */
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  /** 접속 직후 한 번 보여주는 서버 상태 배너. */
  const [motd, setMotd] = useState<string[]>([]);
  const [username, setUsername] = useState('');

  // 로그인은 안경앱 폰 화면(`/`)과 함께 쓴다. 401이 나거나 다른 탭·화면에서
  // 로그인·로그아웃하면 그대로 따라간다.
  useEffect(() => {
    const onSignedOut = () => setSignedIn(false);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === TOKEN_STORAGE) setSignedIn(Boolean(getToken()));
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const [tab, setTab] = useState<Tab>('sessions');

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState('');

  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [allowedRoots, setAllowedRoots] = useState<string[]>([]);
  /** 이어가기 후 원본 삭제 여부. 브라우저에 저장된다. */
  const [deleteOnResume, setDeleteOnResume] = useState(getDeleteOriginalOnResume());
  /** 이름 변경 대상 세션. */
  const [renaming, setRenaming] = useState<SessionInfo | null>(null);
  /** 종료/삭제 확인 대상. */
  const [confirming, setConfirming] = useState<{ session: SessionInfo; kind: 'close' | 'delete' } | null>(
    null,
  );

  const loadWorkspaces = useCallback(async () => {
    try {
      const { workspaces: list } = await api.listWorkspaces();
      setWorkspaces(list);
      setWorkspaceId((cur) => (cur && list.some((w) => w.id === cur) ? cur : (list[0]?.id ?? '')));
    } catch (err) {
      const message = err instanceof Error ? err.message : msg().loadWorkspacesFailed;
      // agent-cli가 아직 안 붙었을 뿐이면 오류로 보이지 않게 한다.
      // 체크리스트 등 서버 자체 기능은 그대로 쓸 수 있다.
      // 서버 메시지는 RELAY_LANG에 따라 바뀌므로 코드로 가린다.
      if (err instanceof ApiError && (err.code === 'no_agent' || err.code === 'agent_error')) return;
      if (message.includes('agent-cli')) return;
      if (message.includes('x-api-key')) setShowSettings(true);
      toast(message, true);
    }
  }, [toast]);

  const loadSessions = useCallback(async () => {
    try {
      const { sessions: list } = await api.listSessions();
      // 내용이 같으면 기존 배열을 유지한다.
      //
      // 5초마다 새 배열을 넣으면 App 전체가 다시 그려지고, 그 여파가
      // 터미널 탭까지 번져 xterm이 포커스를 잃는다.
      setSessions((cur) => (sameSessions(cur, list) ? cur : list));
    } catch {
      // 인증 오류는 워크스페이스 조회에서 이미 알렸다.
    }
  }, []);

  // 로그인 전에는 부르지 않는다. 토큰이 없으면 401만 쌓인다.
  useEffect(() => {
    if (!signedIn) return;
    void api
      .health()
      .then((h) => setAllowedRoots(h.allowedRoots))
      .catch(() => undefined);
    void loadWorkspaces();
    void loadSessions();
  }, [signedIn, loadWorkspaces, loadSessions]);

  // 목록의 상태 표시를 주기적으로 맞춘다. 대화 내용은 SSE로 실시간이다.
  useEffect(() => {
    if (!signedIn) return;
    const t = setInterval(() => void loadSessions(), 5000);
    return () => clearInterval(t);
  }, [signedIn, loadSessions]);

  const active = sessions.find((s) => s.id === activeId);

  function patchSession(updated: SessionInfo): void {
    setSessions((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
  }

  async function closeSession(id: string): Promise<void> {
    try {
      await api.closeSession(id);
      void loadSessions();
    } catch (err) {
      toast(err instanceof Error ? err.message : msg().closeFailed, true);
    }
  }

  async function deleteSession(id: string): Promise<void> {
    try {
      await api.deleteSession(id);
      if (activeId === id) setActiveId('');
      void loadSessions();
    } catch (err) {
      toast(err instanceof Error ? err.message : msg().deleteFailed, true);
    }
  }

  /** 종료된 세션을 되살리고 새로 생긴 세션을 연다. */
  async function resumeSession(id: string): Promise<void> {
    try {
      const { session, deletedOriginal } = await api.resumeSession(id, deleteOnResume);
      await loadSessions();
      setActiveId(session.id);
      toast(deletedOriginal ? msg().resumedDeleted : msg().resumed);
    } catch (err) {
      toast(err instanceof Error ? err.message : msg().resumeFailed, true);
    }
  }

  async function renameSession(id: string, title: string): Promise<void> {
    try {
      await api.renameSession(id, title);
      void loadSessions();
    } catch (err) {
      toast(err instanceof Error ? err.message : msg().renameFailed, true);
    }
  }

  // 접속 직후 서버 상태를 배너로 한 번 보여준다.
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    void api
      .getMotd()
      .then(({ lines }) => {
        if (alive) setMotd(lines);
      })
      .catch(() => {
        // MOTD는 없어도 그만이다.
      });
    return () => {
      alive = false;
    };
  }, [signedIn]);

  // 로그인 전에는 다른 화면을 보여주지 않는다.
  if (!signedIn) {
    return (
      <Login
        onDone={(name) => {
          setUsername(name);
          setSignedIn(true);
        }}
      />
    );
  }

  return (
    <div className="app">
      {motd.length > 0 && (
        <div className="motd">
          <pre className="banner motd-banner" aria-label="FONCDEV">
            {BANNER}
          </pre>
          {motd.map((l, i) => (
            <div key={i} className="motd-line">
              {l}
            </div>
          ))}
          <button className="ghost motd-close" onClick={() => setMotd([])} title={t.close}>
            ✕
          </button>
        </div>
      )}
      <div className="topbar">
        <h1>{t.appTitle}</h1>
        <div className="tabs">
          <button className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>
            {t.tabSessions}
          </button>
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            {t.tabFiles}
          </button>
          <button className={tab === 'term' ? 'active' : ''} onClick={() => setTab('term')}>
            {t.tabTerminal}
          </button>
          <button className={tab === 'todo' ? 'active' : ''} onClick={() => setTab('todo')}>
            {t.tabTodos}
          </button>
          <button className={tab === 'notif' ? 'active' : ''} onClick={() => setTab('notif')}>
            {t.tabNotifications}
          </button>
          <button className={tab === 'monitor' ? 'active' : ''} onClick={() => setTab('monitor')}>
            {t.tabMonitor}
          </button>
        </div>
        <span className="spacer" />
        <select
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          style={{ width: 'auto', maxWidth: 240 }}
          title={t.workspace}
        >
          {workspaces.length === 0 && <option value="">{t.noWorkspaces}</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id}
            </option>
          ))}
        </select>
        <button onClick={() => setShowNewWorkspace(true)} title={t.addWorkspace}>
          ＋
        </button>
        <button className="ghost" onClick={() => setShowSettings(true)} title={t.settings}>
          ⚙
        </button>
        <button
          className="ghost"
          title={username ? t.signOutAs(username) : t.signOut}
          onClick={() => {
            // 서버에서도 토큰을 버린다. 실패해도 로컬은 지운다.
            void api.logout().catch(() => undefined);
            setToken('');
            setSignedIn(false);
          }}
        >
          {t.signOut}
        </button>
      </div>

      <div className="main">
        {tab === 'sessions' && (
          <>
            <div className="sidebar">
              <div className="sidebar-head">
                <span>{t.sessions}</span>
                <span className="spacer" />
                <button className="ghost" onClick={() => setShowNewSession(true)} title={t.newSession}>
                  ＋
                </button>
              </div>
              <div className="sidebar-list">
                {sessions.length === 0 && (
                  <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>
                    {t.noSessions}
                  </div>
                )}
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`session-item${s.id === activeId ? ' active' : ''}`}
                    onClick={() => setActiveId(s.id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={`dot ${s.status}`} />
                      <span className="session-title">
                        {s.title || t.newChat}
                      </span>
                      <button
                        className="ghost"
                        title={t.rename}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming(s);
                        }}
                      >
                        ✎
                      </button>
                      {s.live ? (
                        <button
                          className="ghost"
                          title={t.closeSession}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirming({ session: s, kind: 'close' });
                          }}
                        >
                          ⏻
                        </button>
                      ) : (
                        <>
                          <button
                            className="ghost"
                            title={t.resumeChat}
                            onClick={(e) => {
                              e.stopPropagation();
                              void resumeSession(s.id);
                            }}
                          >
                            ▶
                          </button>
                          <button
                            className="ghost danger"
                            title={t.deleteHistory}
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirming({ session: s, kind: 'delete' });
                            }}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                    <div className="session-meta">
                      <span>{s.workspaceId}</span>
                      <span>·</span>
                      <span>{formatTime(s.lastActivityAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="content">
              {active ? (
                <Chat
                  key={active.id}
                  session={active}
                  onSessionChange={patchSession}
                  onResumed={(id, deletedOriginal) => {
                    void loadSessions();
                    setActiveId(id);
                    toast(
                      deletedOriginal ? t.resumedDeleted : t.resumed,
                    );
                  }}
                  onToast={toast}
                />
              ) : (
                <div className="empty">
                  <div>{t.pickOrCreateSession}</div>
                  <button className="primary" onClick={() => setShowNewSession(true)}>
                    {t.newSession}
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* 터미널은 claudeAgent가 아니라 terminal-agent가 담당한다.
            맥에서 도는 콘솔 화면과 같은 셸을 본다. */}
        {tab === 'term' && <Terminals />}

        {tab === 'todo' && (
          // 전역 목록은 세션과 무관하므로 sessionId를 주지 않는다.
          <div className="todo-page">
            <Checklist onToast={toast} />
          </div>
        )}

        {tab === 'notif' && (
          <div className="todo-page">
            <Notifications onToast={toast} />
          </div>
        )}

        {tab === 'monitor' && <Monitor onToast={toast} />}

        {tab === 'files' &&
          (workspaceId ? (
            <Files workspaceId={workspaceId} onToast={toast} />
          ) : (
            <div className="empty">{t.addWorkspaceFirst}</div>
          ))}
      </div>

      {showNewWorkspace && (
        <NewWorkspaceModal
          allowedRoots={allowedRoots}
          onClose={() => setShowNewWorkspace(false)}
          onCreated={(ws) => {
            setShowNewWorkspace(false);
            setWorkspaceId(ws.id);
            void loadWorkspaces();
          }}
          onToast={toast}
        />
      )}

      {showNewSession && (
        <NewSessionModal
          workspaceId={workspaceId}
          workspaces={workspaces}
          allowedRoots={allowedRoots}
          onClose={() => setShowNewSession(false)}
          onCreated={(s) => {
            setShowNewSession(false);
            setSessions((prev) => [{ ...s, live: true }, ...prev]);
            setActiveId(s.id);
            // 경로를 직접 넣어 새 워크스페이스가 생겼을 수 있다.
            setWorkspaceId(s.workspaceId);
            void loadWorkspaces();
          }}
          onToast={toast}
        />
      )}

      {renaming && (
        <PromptModal
          title={t.renameSession}
          label={t.name}
          initial={renaming.title ?? ''}
          placeholder={t.sessionName}
          confirmLabel={t.renameAction}
          onClose={() => setRenaming(null)}
          onSubmit={(title) => {
            void renameSession(renaming.id, title);
            setRenaming(null);
          }}
        />
      )}

      {confirming && (
        <ConfirmModal
          title={confirming.kind === 'close' ? t.closeSession : t.deleteHistory}
          message={
            confirming.kind === 'close'
              ? t.closeSessionQ(confirming.session.title || t.newChat)
              : t.deleteHistoryQ(confirming.session.title || t.newChat)
          }
          confirmLabel={confirming.kind === 'close' ? t.closeAction : t.delete}
          danger={confirming.kind === 'delete'}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            if (confirming.kind === 'close') void closeSession(confirming.session.id);
            else void deleteSession(confirming.session.id);
            setConfirming(null);
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          deleteOnResume={deleteOnResume}
          onDeleteOnResumeChange={(on) => {
            setDeleteOnResume(on);
            setDeleteOriginalOnResume(on);
          }}
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setShowSettings(false);
            void loadWorkspaces();
            void loadSessions();
          }}
        />
      )}

      {toastNode}
    </div>
  );
}

function NewWorkspaceModal({
  allowedRoots,
  onClose,
  onCreated,
  onToast,
}: {
  allowedRoots: string[];
  onClose: () => void;
  onCreated: (ws: Workspace) => void;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const t = msg();
  const [id, setId] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!id.trim() || !path.trim() || busy) return;
    setBusy(true);
    try {
      const { workspace } = await api.createWorkspace({ id: id.trim(), path: path.trim() });
      onCreated(workspace);
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.registerFailed, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t.addWorkspace} onClose={onClose}>
      <div className="field">
        <label>ID</label>
        <input
          autoFocus
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="my-project"
        />
        <span className="hint">{t.idHint}</span>
      </div>
      <div className="field">
        <label>{t.path}</label>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/develop/projects/my-project"
        />
        <span className="hint">{t.allowedRoots(allowedRoots.join(', ') || t.unknown)}</span>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={!id.trim() || !path.trim() || busy} onClick={() => void submit()}>
          {t.add}
        </button>
      </div>
    </Modal>
  );
}

function NewSessionModal({
  workspaceId,
  workspaces,
  allowedRoots,
  onClose,
  onCreated,
  onToast,
}: {
  workspaceId: string;
  workspaces: Workspace[];
  allowedRoots: string[];
  onClose: () => void;
  onCreated: (s: SessionInfo) => void;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const t = msg();
  // 등록된 워크스페이스를 고르거나, 경로를 직접 입력한다.
  const [mode, setMode] = useState<'workspace' | 'path'>(
    workspaces.length > 0 ? 'workspace' : 'path',
  );
  const [wsId, setWsId] = useState(workspaceId);
  const [path, setPath] = useState('');
  const [model, setModel] = useState('');
  const [policyMode, setPolicyMode] = useState<PolicyMode>('ask-risky');
  const [subPath, setSubPath] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = mode === 'path' ? path.trim().length > 0 : wsId.length > 0;

  async function submit(): Promise<void> {
    if (busy || !ready) return;
    setBusy(true);
    try {
      const { session } = await api.createSession({
        ...(mode === 'path' ? { path: path.trim() } : { workspaceId: wsId }),
        policyMode,
        model: model || undefined,
        subPath: subPath || undefined,
      });
      onCreated(session);
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.createSessionFailed, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t.newSession} onClose={onClose}>
      <div className="field">
        <label>{t.location}</label>
        <div className="tabs" style={{ margin: 0 }}>
          <button
            className={mode === 'workspace' ? 'active' : ''}
            disabled={workspaces.length === 0}
            onClick={() => setMode('workspace')}
          >
            {t.workspace}
          </button>
          <button className={mode === 'path' ? 'active' : ''} onClick={() => setMode('path')}>
            {t.enterPath}
          </button>
        </div>
      </div>

      {mode === 'workspace' ? (
        <div className="field">
          <label>{t.workspace}</label>
          <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} — {w.path}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="field">
          <label>{t.fullPath}</label>
          <input
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) void submit();
            }}
            placeholder="/Users/me/develop/my-project"
            spellCheck={false}
          />
          <span className="hint">
            {t.pathHint}
            <br />
            {t.allowedRoots(allowedRoots.join(', ') || t.unknown)}
          </span>
        </div>
      )}

      <div className="field">
        <label>{t.subPath}</label>
        <input value={subPath} onChange={(e) => setSubPath(e.target.value)} placeholder="src" />
      </div>
      <div className="field">
        <label>{t.model}</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={t.modelPlaceholder}
        />
      </div>
      <div className="field">
        <label>{t.policy}</label>
        <select value={policyMode} onChange={(e) => setPolicyMode(e.target.value as PolicyMode)}>
          <option value="ask-risky">{t.policyAskRisky}</option>
          <option value="ask-all">{t.policyAskAll}</option>
          <option value="auto-approve">{t.policyAutoApprove}</option>
        </select>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? t.starting : t.start}
        </button>
      </div>
    </Modal>
  );
}

function SettingsModal({
  deleteOnResume,
  onDeleteOnResumeChange,
  onClose,
  onSaved,
}: {
  deleteOnResume: boolean;
  onDeleteOnResumeChange: (on: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = msg();
  const [key, setKey] = useState(getApiKey());

  return (
    <Modal title={t.settings} onClose={onClose}>
      <div className="field">
        <label>{t.legacyApiKey}</label>
        <input
          autoFocus
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t.legacyApiKeyPlaceholder}
        />
        <span className="hint">{t.legacyApiKeyHint}</span>
      </div>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={deleteOnResume}
            onChange={(e) => onDeleteOnResumeChange(e.target.checked)}
            style={{ width: 'auto' }}
          />
          {t.deleteOnResume}
        </label>
        <span className="hint" style={{ color: deleteOnResume ? 'var(--warn)' : undefined }}>
          {deleteOnResume
            ? t.deleteOnResumeWarn
            : t.deleteOnResumeOff}
        </span>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>{t.cancel}</button>
        <button
          className="primary"
          onClick={() => {
            setApiKey(key.trim());
            onSaved();
          }}
        >
          {t.save}
        </button>
      </div>
    </Modal>
  );
}
