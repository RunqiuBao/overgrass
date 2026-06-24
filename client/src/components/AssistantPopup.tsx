import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Props {
  /** Viewport coordinates of the click that opened the popup. */
  x: number;
  y: number;
  selection: string;
  fileName?: string;
  language?: string;
  onReplace: (text: string) => void;
  onClose: () => void;
}

const WIDTH = 380;

export default function AssistantPopup({ x, y, selection, fileName, language, onReplace, onClose }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [mode, setMode] = useState<'subscription' | 'api' | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .assistantStatus()
      .then((s) => {
        setConfigured(s.configured);
        setMode(s.mode);
      })
      .catch(() => setConfigured(false));
  }, []);

  // Focus the relevant input once we know whether a key is configured.
  useEffect(() => {
    if (configured === true) promptRef.current?.focus();
    else if (configured === false) keyRef.current?.focus();
  }, [configured]);

  // Position is stateful so the window can be dragged. Start on-screen.
  const [pos, setPos] = useState(() => ({
    left: Math.max(8, Math.min(x, window.innerWidth - WIDTH - 16)),
    top: Math.max(8, Math.min(y, window.innerHeight - 320)),
  }));
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);

  // Drag the window by its header.
  function startDrag(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return; // let header buttons work
    e.preventDefault();
    dragOffset.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top };
    const move = (ev: MouseEvent) => {
      if (!dragOffset.current) return;
      setPos({
        left: Math.max(0, Math.min(ev.clientX - dragOffset.current.dx, window.innerWidth - 60)),
        top: Math.max(0, Math.min(ev.clientY - dragOffset.current.dy, window.innerHeight - 40)),
      });
    };
    const up = () => {
      dragOffset.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    setError(null);
    try {
      await api.assistantSetKey(keyInput.trim());
      setKeyInput('');
      const s = await api.assistantStatus();
      setConfigured(s.configured);
      setMode(s.mode);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function ask() {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    setOptions(null);
    try {
      const result = await api.assistantAsk({ selection, prompt, fileName, language });
      setOptions(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    // Transparent overlay: a click on the backdrop closes the popup.
    <div className="assistant-overlay" onMouseDown={onClose}>
      <div
        className="assistant-popup"
        style={{ left: pos.left, top: pos.top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="assistant-header assistant-drag" onMouseDown={startDrag} title="Drag to move">

          <span>
            ✦ Claude assistant
            {mode && (
              <span className="assistant-mode small muted">
                {' '}
                · {mode === 'subscription' ? 'Pro/Max' : 'API key'}
              </span>
            )}
          </span>
          <button className="icon-btn" title="Close (or click outside)" onClick={onClose}>
            ✕
          </button>
        </div>

        {configured === null ? (
          <div className="assistant-body muted small">Loading…</div>
        ) : configured === false ? (
          <div className="assistant-body">
            <p className="small muted" style={{ marginTop: 0 }}>
              First use — paste one credential (stored on the server, never in the browser):
            </p>
            <ul className="assistant-help small muted">
              <li>
                <strong>Pro/Max subscription</strong> — run <code>claude setup-token</code> and paste
                the <code>sk-ant-oat…</code> token (no per-token cost).
              </li>
              <li>
                <strong>API key</strong> — paste an <code>sk-ant-api…</code> key (pay-per-token).
              </li>
            </ul>
            <input
              ref={keyRef}
              className="assistant-key"
              type="password"
              placeholder="sk-ant-oat… (subscription) or sk-ant-api… (API key)"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveKey()}
            />
            {error && <div className="assistant-error">{error}</div>}
            <div className="assistant-actions">
              <button className="btn btn-primary" onClick={saveKey} disabled={!keyInput.trim()}>
                Save key
              </button>
            </div>
          </div>
        ) : (
          <div className="assistant-body">
            <div className="assistant-selection" title="Selected text">
              {selection.length > 240 ? selection.slice(0, 240) + '…' : selection}
            </div>
            <textarea
              ref={promptRef}
              className="assistant-prompt"
              placeholder="Ask Claude to rewrite, fix, translate… or 'give me 3 options'. (Enter to send, Shift+Enter for newline)"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask();
                }
              }}
            />
            {error && <div className="assistant-error">{error}</div>}

            {/* Single answer → one suggestion box. Multiple → pick-one cards. */}
            {options && options.length === 1 && (
              <>
                <div className="assistant-suggestion-label small muted">Suggestion</div>
                <div className="assistant-suggestion">{options[0]}</div>
              </>
            )}
            {options && options.length > 1 && (
              <>
                <div className="assistant-suggestion-label small muted">
                  {options.length} options — pick your favorite
                </div>
                <div className="assistant-options">
                  {options.map((opt, i) => (
                    <div key={i} className="assistant-option">
                      <div className="assistant-option-text">{opt}</div>
                      <button className="btn btn-primary assistant-option-use" onClick={() => onReplace(opt)}>
                        ✓ Use this
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="assistant-actions">
              {options === null ? (
                <button className="btn btn-primary" onClick={ask} disabled={loading || !prompt.trim()}>
                  {loading ? '⏳ Asking…' : '✦ Ask Claude'}
                </button>
              ) : (
                <>
                  <button className="btn" onClick={() => ask()} disabled={loading}>
                    ↻ Retry
                  </button>
                  <button className="btn" onClick={onClose}>
                    Keep original
                  </button>
                  {options.length === 1 && (
                    <button className="btn btn-primary" onClick={() => onReplace(options[0])}>
                      ✓ Replace selection
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
