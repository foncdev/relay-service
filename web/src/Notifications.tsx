import { useCallback, useEffect, useState } from 'react';
import { api, type Notification } from './api.js';
import { formatDateTime, msg } from './i18n.js';

/** 알림 종류별 표시. 안경과 같은 기호를 쓴다. */
const MARK: Record<Notification['kind'], string> = {
  done: '✓',
  error: '!',
  permission: '?',
  info: '·',
};

/**
 * 알림 목록.
 *
 * 서버에 쌓이므로 안경에서 놓친 완료 알림도 여기서 다시 볼 수 있다.
 */
export function Notifications({ onToast }: { onToast: (m: string, e?: boolean) => void }) {
  const t = msg();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  /** 직접 적어 넣는 알림. 안경으로 메모를 보낼 때 쓴다. */
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { items: list, unread: n } = await api.getNotifications();
      setItems(list);
      setUnread(n);
    } catch {
      // 아직 없거나 서버가 안 붙었다.
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 안경·맥에서 생긴 알림이 바로 보이도록 주기적으로 맞춘다.
  useEffect(() => {
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function openItem(n: Notification): Promise<void> {
    setOpen(open === n.id ? null : n.id);
    if (n.readAt) return;
    try {
      const { unread: left } = await api.readNotification(n.id);
      setUnread(left);
      setItems((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)),
      );
    } catch {
      // 읽음 표시 실패는 내용 보기를 막지 않는다.
    }
  }

  /**
   * 알림을 직접 만든다.
   *
   * 첫 줄이 제목, 나머지가 본문이다. 안경은 목록에서 제목만 보여주고
   * 고르면 본문을 펼치므로 이 구분이 그대로 쓰인다.
   */
  async function add(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    const [title, ...rest] = text.split('\n');
    setBusy(true);
    try {
      const { unread: left } = await api.addNotification({
        title,
        body: rest.join('\n').trim(),
        kind: 'info',
      });
      setUnread(left);
      setInput('');
      // 서버가 id와 시각을 정한다. 직접 끼워 넣지 않고 다시 읽는다.
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.addNotificationFailed, true);
    } finally {
      setBusy(false);
    }
  }

  async function readAll(): Promise<void> {
    try {
      await api.readAllNotifications();
      const now = new Date().toISOString();
      setItems((prev) => prev.map((x) => ({ ...x, readAt: x.readAt ?? now })));
      setUnread(0);
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.actionFailed, true);
    }
  }

  async function clearRead(): Promise<void> {
    try {
      const { removed, items: next, unread: left } = await api.clearReadNotifications();
      setItems(next);
      setUnread(left);
      if (removed > 0) onToast(t.cleared(removed));
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.clearFailed, true);
    }
  }

  async function remove(n: Notification): Promise<void> {
    try {
      await api.deleteNotification(n.id);
      setItems((prev) => prev.filter((x) => x.id !== n.id));
      if (!n.readAt) setUnread((u) => Math.max(u - 1, 0));
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.deleteFailed, true);
    }
  }

  const time = formatDateTime;

  return (
    <div className="checklist">
      <div className="checklist-head">
        <span>{t.notifications}</span>
        {items.length > 0 && (
          <span className="badge">
            {unread}/{items.length}
          </span>
        )}
        <span className="spacer" />
        {unread > 0 && (
          <button className="ghost" onClick={() => void readAll()}>
            {t.markAllRead}
          </button>
        )}
        {items.some((n) => n.readAt) && (
          <button className="ghost" onClick={() => void clearRead()} title={t.clearReadTitle}>
            {t.clearRead}
          </button>
        )}
      </div>

      <div className="checklist-items">
        {items.length === 0 && <div className="checklist-empty">{t.noNotifications}</div>}

        {items.map((n) => (
          <div key={n.id} className={`notif${n.readAt ? ' read' : ''}`}>
            <button className="notif-row" onClick={() => void openItem(n)}>
              <span className={`notif-mark ${n.kind}`}>{MARK[n.kind]}</span>
              <span className="notif-title">{n.title}</span>
              <span className="notif-time">{time(n.createdAt)}</span>
            </button>
            {open === n.id && n.body && <pre className="notif-body">{n.body}</pre>}
            <button className="ghost danger notif-del" title={t.delete} onClick={() => void remove(n)}>
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="checklist-add">
        <textarea
          rows={2}
          value={input}
          placeholder={t.notificationPlaceholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button className="primary" disabled={!input.trim() || busy} onClick={() => void add()}>
          {t.add}
        </button>
      </div>
    </div>
  );
}
