import { useEffect } from 'react';

interface Props {
  onClose: () => void;
}

/** One row: a description on the left, its key(s) on the right. Short tokens
 *  render as <kbd> caps; longer phrases (e.g. "Double-click") pass through. */
const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: 'Recompile', keys: ['Ctrl/Cmd', 'S'] },
  { label: 'Jump back through earlier positions (editor + PDF)', keys: ['Ctrl', 'Alt', '−'] },
  { label: 'Jump forward again', keys: ['Ctrl', 'Alt', '+'] },
  { label: 'Jump source → PDF (SyncTeX)', keys: ['Double-click in the editor'] },
  { label: 'Jump PDF → source (SyncTeX)', keys: ['Double-click in the PDF'] },
  { label: 'Ask Claude (a selection seeds the prompt)', keys: ['Ctrl/Cmd', 'Right-click'] },
];

/** Whether a key token is a real key cap (short) vs. a descriptive phrase. */
function isKeyCap(k: string): boolean {
  return k.length <= 12 && !k.includes(' ');
}

/** Modal listing the workspace keyboard shortcuts. Opened from the settings menu. */
export default function ShortcutsHelp({ onClose }: Props) {
  // Close on Escape, matching the other overlays.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="shortcuts-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-header">
          <span>⌨ Keyboard shortcuts</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <ul className="shortcuts-list">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="shortcut-row">
              <span className="shortcut-label">{s.label}</span>
              <span className="shortcut-keys">
                {s.keys.map((k, i) => (
                  <span key={i}>
                    {i > 0 && <span className="shortcut-plus"> + </span>}
                    {isKeyCap(k) ? <kbd>{k}</kbd> : <span className="shortcut-phrase">{k}</span>}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
