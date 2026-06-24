import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Version } from '../types';

interface Props {
  projectId: string;
  /** Called after a successful restore so the editor can reload from disk. */
  onRestored: () => void;
  onClose: () => void;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function HistoryPanel({ projectId, onRestored, onClose }: Props) {
  const [tab, setTab] = useState<'main' | 'autosave'>('main');
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setVersions(null);
    try {
      setVersions(await api.listHistory(projectId, tab === 'autosave' ? 'autosave' : undefined));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setVersions([]);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab]);

  async function saveVersion() {
    const message = prompt('Name this version (optional):', '');
    if (message === null) return;
    setBusy(true);
    try {
      const v = await api.snapshotVersion(projectId, message || 'Manual snapshot');
      if (!v) setError('No changes since the last version — nothing to save.');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(v: Version, isLatest: boolean) {
    if (isLatest) return;
    if (!confirm(`Roll back to "${v.message}" (${v.hash.slice(0, 8)})?\n\nYour current state is snapshotted first, so this is reversible.`)) {
      return;
    }
    setBusy(true);
    try {
      await api.restoreVersion(projectId, v.hash);
      onRestored();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="history-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-header">
          <span>🕘 Version history</span>
          <div className="history-header-actions">
            <button className="btn btn-sm" onClick={saveVersion} disabled={busy}>
              ＋ Save version
            </button>
            <button className="icon-btn" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        <div className="history-tabs">
          <button
            className={`history-tab${tab === 'main' ? ' active' : ''}`}
            onClick={() => setTab('main')}
          >
            Versions
          </button>
          <button
            className={`history-tab${tab === 'autosave' ? ' active' : ''}`}
            onClick={() => setTab('autosave')}
          >
            Auto-saves
          </button>
        </div>

        {tab === 'autosave' && (
          <p className="muted small history-hint">
            Automatic safety-net snapshots (every ~2 min while editing, if changed). Restore one to
            recover lost work.
          </p>
        )}

        {error && <div className="banner banner-error">{error}</div>}

        <div className="history-body">
          {versions === null ? (
            <p className="muted small" style={{ padding: 12 }}>Loading…</p>
          ) : versions.length === 0 ? (
            <p className="muted small" style={{ padding: 12 }}>No versions yet.</p>
          ) : (
            <ul className="history-list">
              {versions.map((v, i) => {
                const isCurrent = tab === 'main' && i === 0;
                return (
                  <li key={v.hash} className="history-row">
                    <div className="history-row-main">
                      <span className="history-msg">
                        {v.message}
                        {isCurrent && <span className="history-current"> · current</span>}
                      </span>
                      <span className="muted small">
                        {timeAgo(v.date)} · {v.hash.slice(0, 8)}
                      </span>
                    </div>
                    <button
                      className="btn btn-sm"
                      disabled={busy || isCurrent}
                      title={isCurrent ? 'This is the current version' : 'Roll back to this version'}
                      onClick={() => restore(v, isCurrent)}
                    >
                      ⤺ Restore
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
