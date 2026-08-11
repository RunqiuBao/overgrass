import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Props {
  /** Viewport coordinates of the click that opened the popup. */
  x: number;
  y: number;
  /** Text under the cursor when the popup opened — seeds the prompt. */
  selection: string;
  fileName?: string;
  language?: string;
  /** Put `text` in place of the original selection. */
  onReplace: (text: string) => void;
  /** Drop `text` in just after the original selection, leaving it intact. */
  onInsert: (text: string) => void;
  onClose: () => void;
}

const WIDTH = 560;
const HEIGHT = 520;

export default function AssistantPopup({
  x,
  y,
  selection,
  fileName,
  language,
  onReplace,
  onInsert,
  onClose,
}: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [mode, setMode] = useState<'subscription' | 'api' | null>(null);
  const [keyInput, setKeyInput] = useState('');
  // Seeded with the selection so the user can edit it, add an instruction
  // around it, or delete it and ask something else entirely.
  const [prompt, setPrompt] = useState(selection);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  // Focus the relevant input once we know whether a key is configured. The
  // caret goes after the seeded selection, ready for the instruction.
  useEffect(() => {
    if (configured === true) {
      const el = promptRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    } else if (configured === false) keyRef.current?.focus();
  }, [configured]);

  // Position is stateful so the window can be dragged. Start on-screen.
  const [pos, setPos] = useState(() => ({
    left: Math.max(8, Math.min(x, window.innerWidth - WIDTH - 16)),
    top: Math.max(8, Math.min(y, window.innerHeight - HEIGHT - 16)),
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
    setAnswer(null);
    try {
      setAnswer(await api.assistantAsk({ prompt, fileName, language }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function copyAnswer() {
    if (!answer) return;
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy — your browser blocked clipboard access.');
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
          <div className="assistant-body assistant-body-chat">
            <label className="assistant-label small muted" htmlFor="assistant-prompt">
              Your message — edit freely · Ctrl/Cmd+Enter to send
            </label>
            <textarea
              id="assistant-prompt"
              ref={promptRef}
              className="assistant-prompt"
              placeholder="Ask Claude anything — rewrite this, explain it, write a new section…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter sends; plain Enter is a newline, since the box
                // holds real document text the user is editing.
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  ask();
                }
              }}
            />

            {error && <div className="assistant-error">{error}</div>}

            {(answer !== null || loading) && (
              <>
                <div className="assistant-label small muted">
                  {loading ? 'Claude is thinking…' : 'Response'}
                </div>
                <div className="assistant-answer">
                  {loading ? <span className="muted">⏳</span> : answer}
                </div>
              </>
            )}

            <div className="assistant-actions">
              {answer !== null && !loading && (
                <>
                  <button className="btn" title="Copy the response to the clipboard" onClick={copyAnswer}>
                    {copied ? '✓ Copied' : '⧉ Copy'}
                  </button>
                  <button
                    className="btn"
                    title="Insert the response after the text you selected"
                    onClick={() => onInsert(answer)}
                  >
                    ↳ Insert below
                  </button>
                  <button
                    className="btn"
                    title="Replace the text you selected with the response"
                    onClick={() => onReplace(answer)}
                    disabled={!selection}
                  >
                    ⇄ Replace selection
                  </button>
                </>
              )}
              <button className="btn btn-primary" onClick={ask} disabled={loading || !prompt.trim()}>
                {loading ? '⏳ Asking…' : answer === null ? '✦ Ask Claude' : '↻ Ask again'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
