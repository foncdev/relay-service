import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Checklist } from './Checklist.js';
import {
  api,
  getDeleteOriginalOnResume,
  streamSession,
  type PendingPermission,
  type PolicyMode,
  type SessionEvent,
  type SessionInfo,
} from './api.js';

/** 화면에 그릴 대화 한 줄. */
interface Line {
  key: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'error' | 'system';
  text: string;
}

/** 이벤트 하나를 표시용 줄로 바꾼다. 표시할 게 없으면 null. */
function toLine(event: SessionEvent, index: number): Line | null {
  const key = `${event.at}-${index}`;
  const text = (k: string): string => String(event[k] ?? '');

  switch (event.type) {
    case 'user':
      return { key, kind: 'user', text: text('text') };
    case 'assistant':
      return { key, kind: 'assistant', text: text('text') };
    case 'thinking':
      return { key, kind: 'thinking', text: text('text') };
    case 'tool_use':
      return { key, kind: 'tool', text: `⚙ ${text('name')} ${summarizeInput(event.input)}` };
    case 'stderr':
      return { key, kind: 'error', text: text('text') };
    case 'permission_resolved':
      return {
        key,
        kind: 'system',
        text: `${text('toolName')} — ${event.behavior === 'allow' ? '허용' : '거부'}${event.auto ? ' (자동)' : ''}`,
      };
    case 'turn_complete':
      return event.isError ? { key, kind: 'error', text: text('result') } : null;
    case 'closed':
      return { key, kind: 'system', text: '세션이 종료되었습니다.' };
    // 여기까지가 이어받은 이전 대화라는 표시.
    case 'resumed':
      return { key, kind: 'system', text: '── 여기부터 이어서 대화합니다 ──' };
    default:
      return null;
  }
}

/** 도구 입력을 한 줄로 줄인다. 길면 자른다. */
function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // 가장 알아보기 쉬운 필드 하나만 고른다.
  for (const k of ['file_path', 'path', 'command', 'pattern', 'url', 'prompt']) {
    const v = obj[k];
    if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  const s = JSON.stringify(obj);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

export function Chat({
  session,
  onSessionChange,
  onResumed,
  onToast,
}: {
  session: SessionInfo;
  onSessionChange: (s: SessionInfo) => void;
  /** 종료된 세션을 이어가 새 세션이 생겼을 때. */
  onResumed: (id: string, deletedOriginal: boolean) => void;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<PendingPermission[]>(session.pending ?? []);
  const [status, setStatus] = useState(session.status);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [resuming, setResuming] = useState(false);
  /** 할 일 패널을 펼칠지. 필요할 때만 여는 편이 화면이 넓다. */
  const [showTodo, setShowTodo] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);

  const sessionId = session.id;
  const live = session.live;

  // 세션이 바뀌면 이력을 새로 불러오고 스트림을 다시 연다.
  useEffect(() => {
    let cancelled = false;
    setLines([]);
    setPending([]);
    setStatus(session.status);

    api
      .getHistory(sessionId)
      .then(({ events }) => {
        if (cancelled) return;
        const replayed: Line[] = [];
        events.forEach((e, i) => {
          const line = toLine(e, i);
          if (line) replayed.push(line);
        });
        setLines(replayed);
      })
      .catch(() => {
        // 이력이 없는 새 세션이면 빈 화면으로 시작한다.
      });

    if (!live) return () => {
      cancelled = true;
    };

    const stop = streamSession(sessionId, (event) => {
      if (cancelled) return;

      if (event.type === 'status') {
        setStatus(event.status as SessionInfo['status']);
        return;
      }
      if (event.type === 'permission_request') {
        setPending((prev) => [
          ...prev,
          {
            id: String(event.requestId),
            toolName: String(event.toolName),
            input: event.input,
            summary: String(event.summary ?? ''),
            reason: String(event.reason ?? ''),
            at: event.at,
          },
        ]);
        return;
      }
      if (event.type === 'permission_resolved') {
        setPending((prev) => prev.filter((p) => p.id !== event.requestId));
      }

      counter.current += 1;
      const line = toLine(event, counter.current);
      if (line) setLines((prev) => [...prev, line]);
    });

    return () => {
      cancelled = true;
      stop();
    };
    // session.status는 초기값으로만 쓰므로 의존성에 넣지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, live]);

  // 새 줄이 붙으면 맨 아래로 따라간다.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, pending]);

  async function send(): Promise<void> {
    const prompt = input.trim();
    if (!prompt || sending) return;
    setSending(true);
    try {
      const { session: updated } = await api.sendInput(sessionId, prompt);
      setInput('');
      onSessionChange({ ...updated, live: true });
    } catch (err) {
      onToast(err instanceof Error ? err.message : '전송 실패', true);
    } finally {
      setSending(false);
    }
  }

  async function resume(): Promise<void> {
    if (resuming) return;
    setResuming(true);
    try {
      const { session: revived, deletedOriginal } = await api.resumeSession(
        sessionId,
        getDeleteOriginalOnResume(),
      );
      onResumed(revived.id, deletedOriginal);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '이어가기 실패', true);
    } finally {
      setResuming(false);
    }
  }

  async function decide(requestId: string, behavior: 'allow' | 'deny'): Promise<void> {
    setPending((prev) => prev.filter((p) => p.id !== requestId));
    try {
      await api.resolvePermission(sessionId, requestId, behavior);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '권한 처리 실패', true);
    }
  }

  async function changePolicy(mode: PolicyMode): Promise<void> {
    try {
      const { session: updated } = await api.setPolicy(sessionId, mode);
      onSessionChange({ ...updated, live: true });
    } catch (err) {
      onToast(err instanceof Error ? err.message : '정책 변경 실패', true);
    }
  }

  return (
    <>
      <div className="bar">
        <span className={`dot ${status}`} />
        <span className="mono" style={{ color: 'var(--text-dim)' }}>
          {session.cwd}
        </span>
        <span className="spacer" />
        {live && (
          <select
            value={session.policyMode}
            onChange={(e) => void changePolicy(e.target.value as PolicyMode)}
            style={{ width: 'auto' }}
            title="권한 정책"
          >
            <option value="ask-risky">위험한 작업만 확인</option>
            <option value="ask-all">모두 확인</option>
            <option value="auto-approve">전부 자동 승인</option>
          </select>
        )}
        <span className="badge">{session.turns}턴</span>
        <span className="badge">${session.totalCostUsd.toFixed(4)}</span>
        <button
          className={showTodo ? '' : 'ghost'}
          onClick={() => setShowTodo((v) => !v)}
          title="할 일 목록"
        >
          할 일
        </button>
      </div>

      <div className="chat-area">
      <div className="chat" ref={scrollRef}>
        {lines.length === 0 && (
          <div className="empty">
            <div>{live ? '프롬프트를 입력해 대화를 시작하세요.' : '기록된 대화가 없습니다.'}</div>
          </div>
        )}

        {lines.map((line) => (
          <div key={line.key} className={`msg ${line.kind}`}>
            {(line.kind === 'user' || line.kind === 'assistant') && (
              <div className="msg-role">{line.kind === 'user' ? '나' : 'Claude'}</div>
            )}
            <div className="msg-body">{line.text}</div>
          </div>
        ))}

        {pending.map((p) => (
          <div key={p.id} className="perm">
            <div className="perm-title">권한 요청: {p.toolName}</div>
            <div className="perm-summary">{p.summary || p.reason}</div>
            <div className="perm-actions">
              <button className="primary" onClick={() => void decide(p.id, 'allow')}>
                허용
              </button>
              <button className="danger" onClick={() => void decide(p.id, 'deny')}>
                거부
              </button>
            </div>
          </div>
        ))}
      </div>

        {showTodo && <Checklist sessionId={sessionId} onToast={onToast} />}
      </div>

      {live ? (
        <div className="composer">
          <textarea
            value={input}
            placeholder="프롬프트를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="primary" disabled={!input.trim() || sending} onClick={() => void send()}>
            전송
          </button>
        </div>
      ) : (
        <div className="composer" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>종료된 세션입니다.</span>
          <button className="primary" disabled={resuming} onClick={() => void resume()}>
            {resuming ? '이어가는 중…' : '▶ 대화 이어가기'}
          </button>
        </div>
      )}
    </>
  );
}
