import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
        reorder: (ids: string[]) => api.reorderChecklist(sessionId, ids),
      }
    : {
        get: () => api.getGlobalChecklist(),
        add: (t: string) => api.addGlobalChecklist(t),
        toggle: (id: string) => api.toggleGlobalChecklist(id),
        update: (id: string, t: string) => api.updateGlobalChecklist(id, t),
        remove: (id: string) => api.deleteGlobalChecklist(id),
        clear: () => api.clearDoneGlobalChecklist(),
        reorder: (ids: string[]) => api.reorderGlobalChecklist(ids),
      }),
    [sessionId],
  );
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // 끌고 있는 항목과 놓일 자리(그 앞에 놓을 줄 번호, 끝이면 items.length).
  const [drag, setDrag] = useState<{ id: string; target: number } | null>(null);
  const dragging = useRef(false);
  const rows = useRef(new Map<string, HTMLDivElement>());

  const load = useCallback(async () => {
    // 끄는 도중에 새로 읽으면 줄이 바뀌어 놓을 자리가 어긋난다.
    if (dragging.current) return;
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

  /** from 항목을 target 줄 앞으로 옮긴다. 화면을 먼저 바꾸고 서버 순서로 맞춘다. */
  async function move(id: string, target: number): Promise<void> {
    const from = items.findIndex((i) => i.id === id);
    if (from < 0) return;
    const to = target > from ? target - 1 : target;
    if (to === from) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    setItems(next);
    try {
      const { items: saved } = await ops.reorder(next.map((i) => i.id));
      setItems(saved);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '순서 변경 실패', true);
      void load();
    }
  }

  /** 포인터 높이에서 놓일 자리를 찾는다. 줄 가운데보다 위면 그 줄 앞이다. */
  function targetAt(y: number): number {
    for (let n = 0; n < items.length; n += 1) {
      const rect = rows.current.get(items[n]!.id)?.getBoundingClientRect();
      if (rect && y < rect.top + rect.height / 2) return n;
    }
    return items.length;
  }

  function endDrag(commit: boolean): void {
    if (commit && drag) void move(drag.id, drag.target);
    dragging.current = false;
    setDrag(null);
  }

  const done = items.filter((i) => i.done).length;
  // 제자리(자기 앞·바로 뒤)에 놓으면 바뀌는 것이 없다. 선을 보이지 않는다.
  const dragFrom = drag ? items.findIndex((i) => i.id === drag.id) : -1;
  const dropAt = drag && drag.target !== dragFrom && drag.target !== dragFrom + 1 ? drag.target : null;

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

        {items.map((item, n) => (
          <div
            key={item.id}
            ref={(el) => {
              if (el) rows.current.set(item.id, el);
              else rows.current.delete(item.id);
            }}
            className={[
              'todo',
              item.done ? 'done' : '',
              drag?.id === item.id ? 'dragging' : '',
              dropAt === n ? 'drop-before' : '',
              dropAt === items.length && n === items.length - 1 ? 'drop-after' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {/*
              손잡이. 마우스·터치 모두 포인터 이벤트로 끈다(HTML 끌어놓기는 터치에서 안 된다).
              키보드로는 위·아래 화살표로 한 칸씩 옮긴다.
            */}
            <button
              className="todo-handle"
              title="끌어서 순서 바꾸기 (↑↓)"
              aria-label={`순서 바꾸기: ${item.text}`}
              disabled={items.length < 2}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                dragging.current = true;
                setDrag({ id: item.id, target: n });
              }}
              onPointerMove={(e) => {
                if (drag?.id === item.id) setDrag({ id: item.id, target: targetAt(e.clientY) });
              }}
              onPointerUp={() => endDrag(true)}
              onPointerCancel={() => endDrag(false)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' && n > 0) {
                  e.preventDefault();
                  void move(item.id, n - 1);
                } else if (e.key === 'ArrowDown' && n < items.length - 1) {
                  e.preventDefault();
                  void move(item.id, n + 2);
                }
              }}
            >
              ⠿
            </button>
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
