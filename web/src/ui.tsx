import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { formatRelative, msg } from './i18n.js';

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // ESC로 닫는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export interface Toast {
  message: string;
  isError: boolean;
}

/** 화면 하단에 잠깐 뜨는 알림. */
export function useToast(): [ReactNode, (message: string, isError?: boolean) => void] {
  const [toast, setToast] = useState<Toast | null>(null);

  const show = useCallback((message: string, isError = false) => {
    setToast({ message, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.isError ? 5000 : 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const node = toast ? (
    <div className={`toast${toast.isError ? ' error' : ''}`}>{toast.message}</div>
  ) : null;

  return [node, show];
}

/**
 * 값을 입력받는 모달. window.prompt는 브라우저가 조용히 차단할 수 있어 직접 만든다.
 */
export function PromptModal({
  title,
  label,
  initial = '',
  placeholder,
  confirmLabel = msg().ok,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ready = value.trim().length > 0;

  return (
    <Modal title={title} onClose={onClose}>
      <div className="field">
        <label>{label}</label>
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) onSubmit(value.trim());
          }}
        />
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>{msg().cancel}</button>
        <button className="primary" disabled={!ready} onClick={() => onSubmit(value.trim())}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** 위험한 동작을 확인받는 모달. */
export function ConfirmModal({
  title,
  message,
  confirmLabel = msg().ok,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{message}</div>
      <div className="modal-actions">
        <button onClick={onClose}>{msg().cancel}</button>
        <button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 목록 옆에 붙는 경과 시간. 브라우저 언어에 맞춰 Intl로 찍는다. */
export function formatTime(iso: string): string {
  return formatRelative(iso);
}
