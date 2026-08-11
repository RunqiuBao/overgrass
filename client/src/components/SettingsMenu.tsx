import { useEffect, useRef, useState } from 'react';
import { LATEX_ENGINES, ENGINE_LABELS, type LatexEngine } from '../types';
import ShortcutsHelp from './ShortcutsHelp';

interface Props {
  engine: LatexEngine;
  /** Persist the chosen engine; the parent updates project state on success. */
  onEngineChange: (engine: LatexEngine) => void;
  /** True while a change is being saved, to disable the controls briefly. */
  busy?: boolean;
}

/** Gear button in the workspace header; opens a dropdown of project settings. */
export default function SettingsMenu({ engine, onEngineChange, busy }: Props) {
  const [open, setOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <div className="settings-menu" ref={wrap}>
        <button
          className="btn"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Project settings"
          onClick={() => setOpen((o) => !o)}
        >
          ⚙ Settings
        </button>
        {open && (
          <div className="settings-dropdown" role="menu">
            <div className="settings-section">
              <div className="settings-label">LaTeX engine</div>
              {LATEX_ENGINES.map((e) => (
                <label key={e} className="settings-radio">
                  <input
                    type="radio"
                    name="latex-engine"
                    value={e}
                    checked={engine === e}
                    disabled={busy}
                    onChange={() => {
                      if (e !== engine) onEngineChange(e);
                    }}
                  />
                  <span>{ENGINE_LABELS[e]}</span>
                </label>
              ))}
              <div className="settings-hint muted">
                Applied on the next Recompile.
              </div>
            </div>
            <div className="settings-section settings-section-divider">
              <button
                className="settings-item"
                onClick={() => {
                  setShowShortcuts(true);
                  setOpen(false);
                }}
              >
                ⌨ Keyboard shortcuts
              </button>
            </div>
          </div>
        )}
      </div>
      {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}
    </>
  );
}
