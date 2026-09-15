import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ChecklistItem } from './api.js';

/**
 * 할 일 목록.
 *
 * sessionId를 주면 그 세션 전용, 비우면 세션과 무관한 전역 목록이다.
 * 서버에 저장되므로 안경·폰에서 체크한 내용이 여기에도 그대로 보인다.
 */
export function Checklist({
  sessionId,
  onToast,
}: {
  /** 비우면 세션과 무관한 전역 목록을 다룬다. */
  sessionId?: string;
  onToast: (message: string, isError?: boolean) => void;
}) {
  // 전역/세션별로 호출할 API만 갈아끼운다. 화면 로직은 같다.
  // sessionId가 바뀔 때만 다시 만든다. 매 렌더마다 새로 만들면
  // 이걸 쓰는 load가 계속 바뀌어 주기 갱신 타이머가 리셋된다.
  const ops = useMemo(
    () => (sessionId
    ? {
        get: () => api.getChecklist(sessionId),
        add: (t: string) => api.addChecklist(sessionId, t),
        toggle: (id: string) => api.toggleChecklist(sessionId, id),
        update: (id: string, t: string) => api.updateChecklist(sessionId, id, t),
        remove: (id: string) => api.deleteChecklist(sessionId, id),
        clear: () => api.clearDoneChecklist(sessionId),
      }
    : {
        get: () => api.getGlobalChecklist(),
        add: (t: string) => api.addGlobalChecklist(t),
        toggle: (id: string) => api.toggleGlobalChecklist(id),
        update: (id: string, t: string) => api.updateGlobalChecklist(id, t),
        remove: (id: string) => api.deleteGlobalChecklist(id),
        clear: () => api.clearDoneGlobalChecklist(),
      }),
    [sessionId],
  );
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(async () => {
    try {
      const { items: list } = await ops.get();
      setItems(list);
    } catch {
      // 목록이 없는 세션이면 빈 상태로 둔다.
      setItems([]);
    }
  }, [ops]);

  useEffect(() => {
    void load();
  }, [load]);

  // 안경에서 체크한 내용이 반영되도록 주기적으로 맞춘다.
  useEffect(() => {
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function add(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const { items: next } = await ops.add(text);
      setItems(next);
      setInput('');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '추가 실패', true);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: ChecklistItem): Promise<void> {
    // 눌렀을 때 바로 반응하도록 화면을 먼저 바꾼다.
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)));
    try {
      const { items: next } = await ops.toggle(item.id);
      setItems(next);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '변경 실패', true);
      void load();
    }
  }

  async function saveEdit(item: ChecklistItem): Promise<void> {
    const text = draft.trim();
    setEditing(null);
    if (!text || text === item.text) return;
    try {
      await ops.update(item.id, text);
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : '수정 실패', true);
    }
  }

  async function remove(item: ChecklistItem): Promise<void> {
    try {
      await ops.remove(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err) {
      onToast(err instanceof Error ? err.message : '삭제 실패', true);
    }
  }

  async function clearDone(): Promise<void> {
    try {
      const { removed, items: next } = await ops.clear();
      setItems(next);
      if (removed > 0) onToast(`${removed}개 정리했습니다.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '정리 실패', true);
    }
  }

  const done = items.filter((i) => i.done).length;

  return (
    <div className="checklist">
      <div className="checklist-head">
        <span>{sessionId ? '할 일' : '전역 할 일'}</span>
        {items.length > 0 && (
          <span className="badge">
            {done}/{items.length}
          </span>
        )}
        <span className="spacer" />
        {done > 0 && (
          <button className="ghost" onClick={() => void clearDone()} title="완료 항목 정리">
            완료 정리
          </button>
        )}
      </div>

      <div className="checklist-items">
        {items.length === 0 && (
          <div className="checklist-empty">
            할 일이 없습니다.
            <br />
            여러 줄을 넣으면 줄마다 항목이 됩니다.
          </div>
        )}

        {items.map((item) => (
          <div key={item.id} className={`todo${item.done ? ' done' : ''}`}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => void toggle(item)}
              aria-label={item.text}
            />
            {editing === item.id ? (
              <input
                className="todo-edit"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void saveEdit(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveEdit(item);
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <span
                className="todo-text"
                onDoubleClick={() => {
                  setEditing(item.id);
                  setDraft(item.text);
                }}
                title="더블클릭하면 수정"
              >
                {item.text}
              </span>
            )}
            <button className="ghost danger" title="삭제" onClick={() => void remove(item)}>
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="checklist-add">
        <textarea
          rows={2}
          value={input}
          placeholder="할 일 입력 (Enter 추가, Shift+Enter 줄바꿈)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button className="primary" disabled={!input.trim() || busy} onClick={() => void add()}>
          추가
        </button>
      </div>
    </div>
  );
}
