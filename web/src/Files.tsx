import { useCallback, useEffect, useState } from 'react';
import { api, type FileEntry } from './api.js';
import { ConfirmModal, Modal, PromptModal, formatSize } from './ui.js';
import { msg } from './i18n.js';

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
  const t = msg();
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
      onToast(err instanceof Error ? err.message : msg().listFailed, true);
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
      const message = err instanceof Error ? err.message : t.openFileFailed;
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
      onToast(t.saved);
      void refresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.saveFailed, true);
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: FileEntry): Promise<void> {
    try {
      await api.deleteFile(workspaceId, entry.path, entry.type === 'dir');
      if (openPath === entry.path) setOpenPath(null);
      onToast(t.deleted);
      void refresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.deleteFailed, true);
    }
  }

  async function rename(entry: FileEntry, next: string): Promise<void> {
    if (next === entry.name) return;
    try {
      await api.renameFile(workspaceId, entry.path, join(dir, next));
      if (openPath === entry.path) setOpenPath(null);
      void refresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t.renameFailed, true);
    }
  }

  const dirty = openPath !== null && content !== original;

  return (
    <div className="files">
      <div className="file-tree">
        <div className="bar" style={{ borderBottom: 'none', paddingLeft: 4 }}>
          <button className="ghost" onClick={() => setNewFile('')} title={t.newFile}>
            {t.newFileButton}
          </button>
          <button className="ghost" onClick={() => setNewDir('')} title={t.newFolder}>
            {t.newFolderButton}
          </button>
          <span className="spacer" />
          <button
            className="ghost"
            onClick={() => setHidden((v) => !v)}
            title={t.showHidden}
            style={{ color: hidden ? 'var(--accent)' : undefined }}
          >
            {t.hidden}
          </button>
          <button className="ghost" onClick={() => void refresh()} title={t.refresh}>
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
          <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>{t.loading}</div>
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
              title={t.rename}
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(entry);
              }}
            >
              ✎
            </button>
            <button
              className="ghost danger"
              title={t.delete}
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
          <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>{t.empty}</div>
        )}
      </div>

      <div className="file-editor">
        {openPath ? (
          <>
            <div className="bar">
              <span className="mono">{openPath}</span>
              {dirty && <span className="badge" style={{ color: 'var(--warn)' }}>{t.modified}</span>}
              <span className="spacer" />
              <a
                href={api.downloadUrl(workspaceId, openPath)}
                download
                style={{ color: 'var(--text-dim)', fontSize: 12, textDecoration: 'none' }}
              >
                {t.download}
              </a>
              <button onClick={() => setContent(original)} disabled={!dirty}>
                {t.revert}
              </button>
              <button className="primary" onClick={() => void save()} disabled={!dirty || saving}>
                {t.save}
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
          <div className="empty">{t.pickFile}</div>
        )}
      </div>

      {newFile !== null && (
        <Modal title={t.newFile} onClose={() => setNewFile(null)}>
          <div className="field">
            <label>{t.fileName}</label>
            <input
              autoFocus
              value={newFile}
              onChange={(e) => setNewFile(e.target.value)}
              placeholder="notes.md"
            />
            <span className="hint">{t.currentPath(dir)}</span>
          </div>
          <div className="modal-actions">
            <button onClick={() => setNewFile(null)}>{t.cancel}</button>
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
                  onToast(err instanceof Error ? err.message : t.createFailed, true);
                }
              }}
            >
              {t.create}
            </button>
          </div>
        </Modal>
      )}

      {renaming && (
        <PromptModal
          title={t.rename}
          label={t.newName}
          initial={renaming.name}
          confirmLabel={t.renameAction}
          onClose={() => setRenaming(null)}
          onSubmit={(next) => {
            void rename(renaming, next);
            setRenaming(null);
          }}
        />
      )}

      {deleting && (
        <ConfirmModal
          title={t.delete}
          message={t.deleteEntryQ(deleting.type === 'dir', deleting.name)}
          confirmLabel={t.delete}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            void remove(deleting);
            setDeleting(null);
          }}
        />
      )}

      {newDir !== null && (
        <Modal title={t.newFolder} onClose={() => setNewDir(null)}>
          <div className="field">
            <label>{t.folderName}</label>
            <input
              autoFocus
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
              placeholder="src"
            />
            <span className="hint">{t.currentPath(dir)}</span>
          </div>
          <div className="modal-actions">
            <button onClick={() => setNewDir(null)}>{t.cancel}</button>
            <button
              className="primary"
              disabled={!newDir.trim()}
              onClick={async () => {
                try {
                  await api.mkdir(workspaceId, join(dir, newDir.trim()));
                  setNewDir(null);
                  void refresh();
                } catch (err) {
                  onToast(err instanceof Error ? err.message : t.createFailed, true);
                }
              }}
            >
              {t.create}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
