import { useCallback, useEffect, useState } from 'react';
import { api, type FileEntry } from './api.js';
import { ConfirmModal, Modal, PromptModal, formatSize } from './ui.js';

/** 경로를 조각으로 나눈다. 빈 문자열은 루트. */
function crumbsOf(dir: string): Array<{ name: string; path: string }> {
  if (!dir) return [];
  const parts = dir.split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function Files({
  workspaceId,
  onToast,
}: {
  workspaceId: string;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);

  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [saving, setSaving] = useState(false);

  const [newDir, setNewDir] = useState<string | null>(null);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState<FileEntry | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { entries: list } = await api.listFiles(workspaceId, dir, hidden);
      setEntries(list);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '목록 조회 실패', true);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dir, hidden, onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 워크스페이스가 바뀌면 루트로 돌아가고 편집 중이던 파일을 닫는다.
  useEffect(() => {
    setDir('');
    setOpenPath(null);
  }, [workspaceId]);

  async function open(entry: FileEntry): Promise<void> {
    if (entry.type === 'dir') {
      setDir(entry.path);
      return;
    }
    try {
      const { file } = await api.readFile(workspaceId, entry.path);
      setOpenPath(entry.path);
      setContent(file.content);
      setOriginal(file.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : '파일 열기 실패';
      // 바이너리/대용량은 다운로드로 안내한다.
      onToast(message, true);
    }
  }

  async function save(): Promise<void> {
    if (!openPath || saving) return;
    setSaving(true);
    try {
      await api.writeFile(workspaceId, openPath, content);
      setOriginal(content);
      onToast('저장했습니다.');
      void refresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : '저장 실패', true);
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: FileEntry): Promise<void> {
    try {
      await api.deleteFile(workspaceId, entry.path, entry.type === 'dir');
      if (openPath === entry.path) setOpenPath(null);
      onToast('삭제했습니다.');
      void refresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : '삭제 실패', true);
    }
  }

  async function rename(entry: FileEntry, next: string): Promise<void> {
    if (next === entry.name) return;
    try {
      await api.renameFile(workspaceId, entry.path, join(dir, next));
      if (openPath === entry.path) setOpenPath(null);
      void refresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : '이름 변경 실패', true);
    }
  }

  const dirty = openPath !== null && content !== original;

  return (
    <div className="files">
      <div className="file-tree">
        <div className="bar" style={{ borderBottom: 'none', paddingLeft: 4 }}>
          <button className="ghost" onClick={() => setNewFile('')} title="새 파일">
            ＋파일
          </button>
          <button className="ghost" onClick={() => setNewDir('')} title="새 폴더">
            ＋폴더
          </button>
          <span className="spacer" />
          <button
            className="ghost"
            onClick={() => setHidden((v) => !v)}
            title="숨김 파일 표시"
            style={{ color: hidden ? 'var(--accent)' : undefined }}
          >
            숨김
          </button>
          <button className="ghost" onClick={() => void refresh()} title="새로고침">
            ↻
          </button>
        </div>

        <div className="crumbs" style={{ padding: '4px 8px 8px' }}>
          <button onClick={() => setDir('')}>/</button>
          {crumbsOf(dir).map((c) => (
            <span key={c.path} style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-faint)' }}>/</span>
              <button onClick={() => setDir(c.path)}>{c.name}</button>
            </span>
          ))}
        </div>

        {dir && (
          <div
            className="file-row"
            onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))}
          >
            <span>📁</span>
            <span className="file-name" style={{ color: 'var(--text-dim)' }}>
              ..
            </span>
          </div>
        )}

        {loading && entries.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>불러오는 중…</div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.path}
            className={`file-row${openPath === entry.path ? ' active' : ''}`}
            onClick={() => void open(entry)}
          >
            <span>{entry.type === 'dir' ? '📁' : '📄'}</span>
            <span className="file-name">{entry.name}</span>
            {entry.type === 'file' && <span className="file-size">{formatSize(entry.size)}</span>}
            <button
              className="ghost"
              title="이름 변경"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(entry);
              }}
            >
              ✎
            </button>
            <button
              className="ghost danger"
              title="삭제"
              onClick={(e) => {
                e.stopPropagation();
                setDeleting(entry);
              }}
            >
              ✕
            </button>
          </div>
        ))}

        {!loading && entries.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>비어 있습니다.</div>
        )}
      </div>

      <div className="file-editor">
        {openPath ? (
          <>
            <div className="bar">
              <span className="mono">{openPath}</span>
              {dirty && <span className="badge" style={{ color: 'var(--warn)' }}>수정됨</span>}
              <span className="spacer" />
              <a
                href={api.downloadUrl(workspaceId, openPath)}
                download
                style={{ color: 'var(--text-dim)', fontSize: 12, textDecoration: 'none' }}
              >
                다운로드
              </a>
              <button onClick={() => setContent(original)} disabled={!dirty}>
                되돌리기
              </button>
              <button className="primary" onClick={() => void save()} disabled={!dirty || saving}>
                저장
              </button>
            </div>
            <textarea
              value={content}
              spellCheck={false}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+S로 저장한다.
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          </>
        ) : (
          <div className="empty">왼쪽에서 파일을 선택하세요.</div>
        )}
      </div>

      {newFile !== null && (
        <Modal title="새 파일" onClose={() => setNewFile(null)}>
          <div className="field">
            <label>파일 이름</label>
            <input
              autoFocus
              value={newFile}
              onChange={(e) => setNewFile(e.target.value)}
              placeholder="notes.md"
            />
            <span className="hint">현재 경로: /{dir}</span>
          </div>
          <div className="modal-actions">
            <button onClick={() => setNewFile(null)}>취소</button>
            <button
              className="primary"
              disabled={!newFile.trim()}
              onClick={async () => {
                try {
                  const p = join(dir, newFile.trim());
                  await api.writeFile(workspaceId, p, '');
                  setNewFile(null);
                  setOpenPath(p);
                  setContent('');
                  setOriginal('');
                  void refresh();
                } catch (err) {
                  onToast(err instanceof Error ? err.message : '생성 실패', true);
                }
              }}
            >
              만들기
            </button>
          </div>
        </Modal>
      )}

      {renaming && (
        <PromptModal
          title="이름 변경"
          label="새 이름"
          initial={renaming.name}
          confirmLabel="변경"
          onClose={() => setRenaming(null)}
          onSubmit={(next) => {
            void rename(renaming, next);
            setRenaming(null);
          }}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="삭제"
          message={`${deleting.type === 'dir' ? '디렉토리' : '파일'} "${deleting.name}"을(를) 삭제할까요?${
            deleting.type === 'dir' ? '\n안에 든 내용도 함께 삭제됩니다.' : ''
          }\n되돌릴 수 없습니다.`}
          confirmLabel="삭제"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            void remove(deleting);
            setDeleting(null);
          }}
        />
      )}

      {newDir !== null && (
        <Modal title="새 폴더" onClose={() => setNewDir(null)}>
          <div className="field">
            <label>폴더 이름</label>
            <input
              autoFocus
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
              placeholder="src"
            />
            <span className="hint">현재 경로: /{dir}</span>
          </div>
          <div className="modal-actions">
            <button onClick={() => setNewDir(null)}>취소</button>
            <button
              className="primary"
              disabled={!newDir.trim()}
              onClick={async () => {
                try {
                  await api.mkdir(workspaceId, join(dir, newDir.trim()));
                  setNewDir(null);
                  void refresh();
                } catch (err) {
                  onToast(err instanceof Error ? err.message : '생성 실패', true);
                }
              }}
            >
              만들기
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
