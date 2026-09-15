import { useCallback, useEffect, useState } from 'react';
import { BANNER } from './banner.js';
import { Login } from './Login.js';
import {
  api,
  getToken,
  setToken,
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
import { Checklist } from './Checklist.js';
import { Terminals } from './Terminals.js';
import { Files } from './Files.js';
import { ConfirmModal, Modal, PromptModal, formatTime, useToast } from './ui.js';

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

type Tab = 'sessions' | 'files' | 'term' | 'todo' | 'notif';

export function App() {
  const [toastNode, toast] = useToast();
  /** 로그인 여부. 토큰이 있으면 이미 로그인한 상태로 본다. */
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  /** 접속 직후 한 번 보여주는 서버 상태 배너. */
  const [motd, setMotd] = useState<string[]>([]);
  const [username, setUsername] = useState('');
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
      const message = err instanceof Error ? err.message : '워크스페이스 조회 실패';
      // agent-cli가 아직 안 붙었을 뿐이면 오류로 보이지 않게 한다.
      // 체크리스트 등 서버 자체 기능은 그대로 쓸 수 있다.
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
      toast(err instanceof Error ? err.message : '종료 실패', true);
    }
  }

  async function deleteSession(id: string): Promise<void> {
    try {
      await api.deleteSession(id);
      if (activeId === id) setActiveId('');
      void loadSessions();
    } catch (err) {
      toast(err instanceof Error ? err.message : '삭제 실패', true);
    }
  }

  /** 종료된 세션을 되살리고 새로 생긴 세션을 연다. */
  async function resumeSession(id: string): Promise<void> {
    try {
      const { session, deletedOriginal } = await api.resumeSession(id, deleteOnResume);
      await loadSessions();
      setActiveId(session.id);
      toast(deletedOriginal ? '대화를 이어갑니다. 원본 기록은 삭제했습니다.' : '대화를 이어갑니다.');
    } catch (err) {
      toast(err instanceof Error ? err.message : '이어가기 실패', true);
    }
  }

  async function renameSession(id: string, title: string): Promise<void> {
    try {
      await api.renameSession(id, title);
      void loadSessions();
    } catch (err) {
      toast(err instanceof Error ? err.message : '이름 변경 실패', true);
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
          <button className="ghost motd-close" onClick={() => setMotd([])} title="닫기">
            ✕
          </button>
        </div>
      )}
      <div className="topbar">
        <h1>Claude Code 매니저</h1>
        <div className="tabs">
          <button className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>
            세션
          </button>
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            파일
          </button>
          <button className={tab === 'term' ? 'active' : ''} onClick={() => setTab('term')}>
            터미널
          </button>
          <button className={tab === 'todo' ? 'active' : ''} onClick={() => setTab('todo')}>
            할 일
          </button>
          <button className={tab === 'notif' ? 'active' : ''} onClick={() => setTab('notif')}>
            알림
          </button>
        </div>
        <span className="spacer" />
        <select
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          style={{ width: 'auto', maxWidth: 240 }}
          title="워크스페이스"
        >
          {workspaces.length === 0 && <option value="">워크스페이스 없음</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id}
            </option>
          ))}
        </select>
        <button onClick={() => setShowNewWorkspace(true)} title="워크스페이스 추가">
          ＋
        </button>
        <button className="ghost" onClick={() => setShowSettings(true)} title="설정">
          ⚙
        </button>
        <button
          className="ghost"
          title={username ? `${username} — 로그아웃` : '로그아웃'}
          onClick={() => {
            // 서버에서도 토큰을 버린다. 실패해도 로컬은 지운다.
            void api.logout().catch(() => undefined);
            setToken('');
            setSignedIn(false);
          }}
        >
          로그아웃
        </button>
      </div>

      <div className="main">
        {tab === 'sessions' && (
          <>
            <div className="sidebar">
              <div className="sidebar-head">
                <span>세션</span>
                <span className="spacer" />
                <button className="ghost" onClick={() => setShowNewSession(true)} title="새 세션">
                  ＋
                </button>
              </div>
              <div className="sidebar-list">
                {sessions.length === 0 && (
                  <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>
                    세션이 없습니다.
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
                        {s.title || '새 대화'}
                      </span>
                      <button
                        className="ghost"
                        title="이름 변경"
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
                          title="세션 종료"
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
                            title="대화 이어가기"
                            onClick={(e) => {
                              e.stopPropagation();
                              void resumeSession(s.id);
                            }}
                          >
                            ▶
                          </button>
                          <button
                            className="ghost danger"
                            title="기록 삭제"
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
                      deletedOriginal
                        ? '대화를 이어갑니다. 원본 기록은 삭제했습니다.'
                        : '대화를 이어갑니다.',
                    );
                  }}
                  onToast={toast}
                />
              ) : (
                <div className="empty">
                  <div>세션을 선택하거나 새로 만드세요.</div>
                  <button className="primary" onClick={() => setShowNewSession(true)}>
                    새 세션
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

        {tab === 'files' &&
          (workspaceId ? (
            <Files workspaceId={workspaceId} onToast={toast} />
          ) : (
            <div className="empty">먼저 워크스페이스를 추가하세요.</div>
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
          title="세션 이름 변경"
          label="이름"
          initial={renaming.title ?? ''}
          placeholder="세션 이름"
          confirmLabel="변경"
          onClose={() => setRenaming(null)}
          onSubmit={(title) => {
            void renameSession(renaming.id, title);
            setRenaming(null);
          }}
        />
      )}

      {confirming && (
        <ConfirmModal
          title={confirming.kind === 'close' ? '세션 종료' : '기록 삭제'}
          message={
            confirming.kind === 'close'
              ? `"${confirming.session.title || '새 대화'}" 세션을 종료할까요?\n대화 기록은 남습니다.`
              : `"${confirming.session.title || '새 대화'}" 의 대화 기록을 완전히 삭제할까요?\n되돌릴 수 없습니다.`
          }
          confirmLabel={confirming.kind === 'close' ? '종료' : '삭제'}
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
      onToast(err instanceof Error ? err.message : '등록 실패', true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="워크스페이스 추가" onClose={onClose}>
      <div className="field">
        <label>ID</label>
        <input
          autoFocus
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="my-project"
        />
        <span className="hint">영문/숫자/밑줄/하이픈</span>
      </div>
      <div className="field">
        <label>경로</label>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/develop/projects/my-project"
        />
        <span className="hint">
          허용 루트: {allowedRoots.join(', ') || '(확인 불가)'}
        </span>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={!id.trim() || !path.trim() || busy} onClick={() => void submit()}>
          추가
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
      onToast(err instanceof Error ? err.message : '세션 생성 실패', true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="새 세션" onClose={onClose}>
      <div className="field">
        <label>작업 위치</label>
        <div className="tabs" style={{ margin: 0 }}>
          <button
            className={mode === 'workspace' ? 'active' : ''}
            disabled={workspaces.length === 0}
            onClick={() => setMode('workspace')}
          >
            워크스페이스
          </button>
          <button className={mode === 'path' ? 'active' : ''} onClick={() => setMode('path')}>
            경로 직접 입력
          </button>
        </div>
      </div>

      {mode === 'workspace' ? (
        <div className="field">
          <label>워크스페이스</label>
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
          <label>전체 경로</label>
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
            ~ 사용 가능. 처음 쓰는 경로는 워크스페이스로 자동 등록됩니다.
            <br />
            허용 루트: {allowedRoots.join(', ') || '(확인 불가)'}
          </span>
        </div>
      )}

      <div className="field">
        <label>하위 경로 (선택)</label>
        <input value={subPath} onChange={(e) => setSubPath(e.target.value)} placeholder="src" />
      </div>
      <div className="field">
        <label>모델 (선택)</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="비워두면 기본값"
        />
      </div>
      <div className="field">
        <label>권한 정책</label>
        <select value={policyMode} onChange={(e) => setPolicyMode(e.target.value as PolicyMode)}>
          <option value="ask-risky">위험한 작업만 확인</option>
          <option value="ask-all">모두 확인</option>
          <option value="auto-approve">전부 자동 승인</option>
        </select>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? '시작하는 중…' : '시작'}
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
  const [key, setKey] = useState(getApiKey());

  return (
    <Modal title="설정" onClose={onClose}>
      <div className="field">
        <label>API 키</label>
        <input
          autoFocus
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="서버의 AGENT_API_KEY"
        />
        <span className="hint">
          브라우저에만 저장됩니다. 서버에 AGENT_API_KEY가 없으면 비워두세요.
        </span>
      </div>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={deleteOnResume}
            onChange={(e) => onDeleteOnResumeChange(e.target.checked)}
            style={{ width: 'auto' }}
          />
          이어가기 후 원본 기록 삭제
        </label>
        <span className="hint" style={{ color: deleteOnResume ? 'var(--warn)' : undefined }}>
          {deleteOnResume
            ? '⚠ 이어간 뒤 원본 대화 기록이 영구 삭제됩니다. 되돌릴 수 없습니다.'
            : '목록에 원본이 함께 남습니다 (기본).'}
        </span>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>취소</button>
        <button
          className="primary"
          onClick={() => {
            setApiKey(key.trim());
            onSaved();
          }}
        >
          저장
        </button>
      </div>
    </Modal>
  );
}
