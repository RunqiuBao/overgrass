import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { oneDark } from '@codemirror/theme-one-dark';

interface Props {
  /** Identity of the open document; changing it reloads editor content. */
  docKey: string;
  value: string;
  language: 'latex' | 'text';
  readOnly?: boolean;
  onChange: (value: string) => void;
  /** Double-click in the editor -> forward SyncTeX search to the PDF. */
  onDoubleClickLine?: (line: number, column: number) => void;
  /** When this nonce changes, scroll to and flash `revealLine` (inverse search). */
  revealLine?: number | null;
  revealNonce?: number;
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
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Keep latest callbacks without recreating the editor on every render.
  const onChangeRef = useRef(onChange);
  const onDoubleClickRef = useRef(onDoubleClickLine);
  onChangeRef.current = onChange;
  onDoubleClickRef.current = onDoubleClickLine;

  // (Re)create the editor whenever the open document or language changes.
  useEffect(() => {
    if (!host.current) return;

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
      }),
      EditorView.lineWrapping,
      oneDark,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
      EditorState.readOnly.of(!!readOnly),
    ];
    if (language === 'latex') extensions.push(StreamLanguage.define(stex));

    const state = EditorState.create({ doc: value, extensions });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, language, readOnly]);

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

  // Sync external value changes (e.g. switching files) into the editor.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <div className="code-editor" ref={host} />;
}
