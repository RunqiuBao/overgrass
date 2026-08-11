import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { oneDark } from '@codemirror/theme-one-dark';

/** Where the caret sat in a document, remembered across file switches. */
export interface EditorPos {
  anchor: number;
  head: number;
}

/** Live caret + scroll of the editor, reported as the user moves around. */
export interface EditorNav {
  /** Start of the selection — the one position the go-back history records
   *  (selecting a sentence remembers where the sentence begins). */
  pos: number;
  /** Viewport offset; used only to detect jumps, never restored directly. */
  scrollTop: number;
}

interface Props {
  /** Identity of the open document; changing it reloads editor content. */
  docKey: string;
  value: string;
  language: 'latex' | 'text';
  readOnly?: boolean;
  onChange: (value: string) => void;
  /** Caret to restore when `docKey` opens, if it has been visited before. */
  getPosition?: (docKey: string) => EditorPos | undefined;
  /** Record the caret as `docKey` is torn down. */
  savePosition?: (docKey: string, pos: EditorPos) => void;
  /** Double-click in the editor -> forward SyncTeX search to the PDF. */
  onDoubleClickLine?: (line: number, column: number) => void;
  /** When this nonce changes, scroll to and flash `revealLine` (inverse search). */
  revealLine?: number | null;
  revealNonce?: number;
  /** Ctrl/Cmd+right-click on a selection -> open the Claude assistant. */
  onContextRequest?: (info: {
    text: string;
    from: number;
    to: number;
    x: number;
    y: number;
  }) => void;
  /** When this nonce changes, replace [from,to] with `text` (assistant substitute). */
  applyEdit?: { from: number; to: number; text: string } | null;
  applyEditNonce?: number;
  /** Report the live caret + scroll as the user moves/scrolls (for the go-back history). */
  onNavChange?: (nav: EditorNav) => void;
  /** When this nonce changes, put the caret at `pos` and centre it vertically. */
  navTarget?: { pos: number } | null;
  navNonce?: number;
}

export default function CodeEditor({
  docKey,
  value,
  language,
  readOnly,
  onChange,
  onDoubleClickLine,
  revealLine,
  revealNonce,
  onContextRequest,
  applyEdit,
  applyEditNonce,
  getPosition,
  savePosition,
  onNavChange,
  navTarget,
  navNonce,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Keep latest callbacks without recreating the editor on every render.
  const onChangeRef = useRef(onChange);
  const onDoubleClickRef = useRef(onDoubleClickLine);
  const onContextRef = useRef(onContextRequest);
  const getPositionRef = useRef(getPosition);
  const savePositionRef = useRef(savePosition);
  const onNavChangeRef = useRef(onNavChange);
  onChangeRef.current = onChange;
  onDoubleClickRef.current = onDoubleClickLine;
  onContextRef.current = onContextRequest;
  getPositionRef.current = getPosition;
  savePositionRef.current = savePosition;
  onNavChangeRef.current = onNavChange;

  // (Re)create the editor whenever the open document or language changes.
  useEffect(() => {
    if (!host.current) return;

    // Report the live caret + scroll for the go-back history. Only the start of
    // the selection matters — that is the spot "back" returns to.
    const report = () => {
      const cv = view.current;
      if (!cv || !onNavChangeRef.current) return;
      const sel = cv.state.selection.main;
      onNavChangeRef.current({ pos: sel.from, scrollTop: cv.scrollDOM.scrollTop });
    };

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter(),
      history(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
      EditorView.domEventHandlers({
        dblclick(event, v) {
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const line = v.state.doc.lineAt(pos);
          onDoubleClickRef.current?.(line.number, pos - line.from + 1);
          return false; // let CodeMirror keep its default word-selection
        },
        contextmenu(event, v) {
          // Ctrl/Cmd + right-click on a selection opens the Claude assistant.
          if (!event.ctrlKey && !event.metaKey) return false; // normal right-click menu
          const sel = v.state.selection.main;
          const text = v.state.sliceDoc(sel.from, sel.to);
          if (!text.trim()) return false; // need a selection
          event.preventDefault();
          onContextRef.current?.({
            text,
            from: sel.from,
            to: sel.to,
            x: event.clientX,
            y: event.clientY,
          });
          return true;
        },
      }),
      EditorView.lineWrapping,
      oneDark,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        // Report the live caret whenever the selection moves, so the workspace
        // can remember where we were for the go-back history.
        if (u.selectionSet) report();
      }),
      EditorState.readOnly.of(!!readOnly),
    ];
    if (language === 'latex') extensions.push(StreamLanguage.define(stex));

    const state = EditorState.create({ doc: value, extensions });

    // Restore the caret from the last visit. The file may have changed on disk
    // since (a history restore), so clamp against the built doc rather than
    // `value`: CodeMirror normalises CRLF, so doc.length can be shorter than
    // the raw string, and an out-of-range selection would throw.
    const saved = getPositionRef.current?.(docKey);
    const len = state.doc.length;
    const clamp = (n: number) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), len) : 0);
    const restore = saved ? { anchor: clamp(saved.anchor), head: clamp(saved.head) } : null;

    const v = new EditorView({ state, parent: host.current });
    view.current = v;

    // Scrolling doesn't fire the updateListener, so report scroll separately
    // (the selection stays put but the viewport — what the user sees — moves).
    // Scroll events arrive outside CodeMirror's update cycle, so reading the
    // layout directly is fine here.
    v.scrollDOM.addEventListener('scroll', report, { passive: true });

    if (restore) {
      // Selection-only: docChanged stays false, so the updateListener above
      // does not fire and this cannot mark the file dirty.
      v.dispatch({
        selection: restore,
        effects: EditorView.scrollIntoView(restore.anchor, { y: 'center' }),
      });
      // CodeMirror hides the caret while unfocused, and clicking to focus would
      // throw away the position we just restored.
      v.focus();
    }

    return () => {
      // Runs before the next create (so `docKey` here is the outgoing document)
      // and on unmount — opening an image or binary file drops this component.
      const sel = v.state.selection.main;
      savePositionRef.current?.(docKey, { anchor: sel.anchor, head: sel.head });
      v.scrollDOM.removeEventListener('scroll', report);
      v.destroy();
      view.current = null;
    };
    // The reveal/applyEdit effects below must stay declared after this one, so
    // they run after a (re)create and win over the restore above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, language, readOnly]);

  // Go-back history: put the caret back and centre it vertically. Goes through
  // CodeMirror's own scrollIntoView pipeline because a raw scrollDOM.scrollTop
  // write gets overridden by its measure cycle (scroll anchoring, or a pending
  // centered scroll from the per-file caret restore).
  useEffect(() => {
    const v = view.current;
    if (!v || !navTarget) return;
    const len = v.state.doc.length;
    const pos = Number.isFinite(navTarget.pos) ? Math.min(Math.max(navTarget.pos, 0), len) : 0;
    v.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    v.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navNonce]);

  // Inverse search: scroll to and briefly highlight a line.
  useEffect(() => {
    const v = view.current;
    if (!v || !revealLine) return;
    const total = v.state.doc.lines;
    const target = Math.min(Math.max(1, revealLine), total);
    const lineObj = v.state.doc.line(target);
    v.dispatch({
      selection: { anchor: lineObj.from, head: lineObj.to },
      effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
    });
    v.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce]);

  // Assistant substitute: replace a range with the suggested text.
  useEffect(() => {
    const v = view.current;
    if (!v || !applyEdit) return;
    const len = v.state.doc.length;
    const from = Math.min(Math.max(0, applyEdit.from), len);
    const to = Math.min(Math.max(from, applyEdit.to), len);
    v.dispatch({
      changes: { from, to, insert: applyEdit.text },
      selection: { anchor: from + applyEdit.text.length },
    });
    v.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyEditNonce]);

  // Sync external value changes (e.g. a history restore) into the editor. A file
  // switch rebuilds the view around the new text already, so this no-ops there.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) {
      const sel = v.state.selection.main;
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
      // Put the caret back: a change spanning the whole document does not carry
      // it through. Clamp against the rebuilt doc (CRLF may have been
      // normalised away), and keep it a second, selection-only transaction so
      // the length is known and no extra change event fires.
      const len = v.state.doc.length;
      v.dispatch({
        selection: { anchor: Math.min(sel.anchor, len), head: Math.min(sel.head, len) },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <div className="code-editor" ref={host} />;
}
