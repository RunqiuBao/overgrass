import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { CompileResult, FileNode, ProjectMeta } from '../types';
import FileTree from '../components/FileTree';
import CodeEditor from '../components/CodeEditor';
import PdfViewer, { type PdfHighlight } from '../components/PdfViewer';
import AssistantPopup from '../components/AssistantPopup';
import HistoryPanel from '../components/HistoryPanel';

const TEXT_EXTS = ['.tex', '.txt', '.bib', '.cls', '.sty', '.md', '.markdown', '.json', '.yml', '.yaml', '.bst', '.csv', '.cfg', '.toml'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(i).toLowerCase();
}
function isText(path: string): boolean {
  const e = extOf(path);
  return e === '' || TEXT_EXTS.includes(e);
}
function isImage(path: string): boolean {
  return IMAGE_EXTS.includes(extOf(path));
}

export default function Workspace() {
  const { id = '' } = useParams();
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // SyncTeX state
  const [pdfHighlight, setPdfHighlight] = useState<PdfHighlight | null>(null);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [revealNonce, setRevealNonce] = useState(0);
  const syncNonce = useRef(0);

  // Claude assistant state
  const [assist, setAssist] = useState<{ x: number; y: number; text: string; from: number; to: number } | null>(null);
  const [applyEdit, setApplyEdit] = useState<{ from: number; to: number; text: string } | null>(null);
  const [applyEditNonce, setApplyEditNonce] = useState(0);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef<string>(''); // target folder for the next upload

  // Resizable panes. Widths (px) for the file-tree and PDF panes; the editor
  // pane flexes to fill whatever is left. Persisted across sessions.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [filesWidth, setFilesWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('ws.filesWidth'));
    return Number.isFinite(v) && v > 0 ? v : 240;
  });
  const [pdfWidth, setPdfWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('ws.pdfWidth'));
    return Number.isFinite(v) && v > 0 ? v : 560;
  });
  useEffect(() => { localStorage.setItem('ws.filesWidth', String(filesWidth)); }, [filesWidth]);
  useEffect(() => { localStorage.setItem('ws.pdfWidth', String(pdfWidth)); }, [pdfWidth]);

  // Refs mirror the latest widths so the move handler reads current values
  // without re-binding listeners on every drag tick.
  const filesWidthRef = useRef(filesWidth);
  const pdfWidthRef = useRef(pdfWidth);
  filesWidthRef.current = filesWidth;
  pdfWidthRef.current = pdfWidth;

  // Start dragging a gutter. `which` selects which pane the gutter resizes.
  const startResize = useCallback((which: 'files' | 'pdf') => (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const body = bodyRef.current;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      // Keep at least 200px for the editor pane between the two gutters.
      const minEditor = 200;
      if (which === 'files') {
        const max = rect.width - pdfWidthRef.current - minEditor;
        setFilesWidth(Math.max(120, Math.min(ev.clientX - rect.left, max)));
      } else {
        const max = rect.width - filesWidthRef.current - minEditor;
        setPdfWidth(Math.max(240, Math.min(rect.right - ev.clientX, max)));
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-col');
    };
    document.body.classList.add('resizing-col');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const refreshTree = useCallback(async () => {
    setTree(await api.getFileTree(id));
  }, [id]);

  // Initial load: project meta, file tree, and open the main file.
  useEffect(() => {
    (async () => {
      try {
        const meta = await api.getProject(id);
        setProject(meta);
        const nodes = await api.getFileTree(id);
        setTree(nodes);
        const first = meta.mainFile ?? findFirstTex(nodes);
        if (first) await openFile(first);
        // Show the previously-built PDF (if any) without forcing a recompile.
        try {
          const pdf = await api.currentPdf(id);
          if (pdf) setPdfUrl(`${api.pdfUrl(id, pdf)}&t=${Date.now()}`);
        } catch {
          /* no prior build — leave the PDF pane empty */
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function openFile(path: string) {
    // Persist pending edits before switching away.
    if (dirty && openPath) await saveNow(openPath, content);
    setOpenPath(path);
    if (isText(path)) {
      try {
        setContent(await api.readFile(id, path));
        setDirty(false);
      } catch (e) {
        setError((e as Error).message);
      }
    } else {
      setContent('');
      setDirty(false);
    }
  }

  const saveNow = useCallback(
    async (path: string, value: string) => {
      setSaving(true);
      try {
        await api.writeFile(id, path, value);
        setDirty(false);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [id],
  );

  function handleChange(value: string) {
    setContent(value);
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const path = openPath;
    if (!path) return;
    saveTimer.current = setTimeout(() => saveNow(path, value), 800);
  }

  async function recompile() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (openPath && dirty) await saveNow(openPath, content);
    setCompiling(true);
    setError(null);
    setDiagnosis(null);
    try {
      const res = await api.compile(id);
      setResult(res);
      if (res.pdfPath) {
        // Cache-bust so the viewer reloads the freshly built PDF.
        setPdfUrl(`${api.pdfUrl(id, res.pdfPath)}&t=${Date.now()}`);
      }
      setShowLog(res.errors.length > 0 || !res.success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCompiling(false);
    }
  }

  // Ctrl/Cmd+S triggers Recompile (Overleaf-style), from anywhere in the
  // workspace. Capture phase + preventDefault overrides the browser's Save
  // dialog and runs before CodeMirror sees the key.
  const recompileRef = useRef(recompile);
  recompileRef.current = recompile;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (!compiling) recompileRef.current();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [compiling]);

  // --- File operations ------------------------------------------------------

  async function handleCreate(parentDir: string, type: 'file' | 'dir') {
    const label = type === 'dir' ? 'New folder name' : 'New file name';
    const name = prompt(label + (type === 'file' ? ' (e.g. section1.tex)' : ''));
    if (!name) return;
    const path = parentDir ? `${parentDir}/${name}` : name;
    try {
      await api.createEntry(id, path, type);
      await refreshTree();
      if (type === 'file' && isText(path)) await openFile(path);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleRename(node: FileNode) {
    const next = prompt('Rename to', node.path);
    if (!next || next === node.path) return;
    try {
      await api.renameEntry(id, node.path, next);
      if (openPath === node.path) setOpenPath(next);
      await refreshTree();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDelete(node: FileNode) {
    if (!confirm(`Delete “${node.path}”?`)) return;
    try {
      await api.deleteEntry(id, node.path);
      if (openPath === node.path) {
        setOpenPath(null);
        setContent('');
      }
      await refreshTree();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleSetMain(node: FileNode) {
    try {
      const meta = await api.updateProject(id, { mainFile: node.path });
      setProject(meta);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Directory of the currently open file ('' = project root).
  function currentDir(): string {
    if (!openPath) return '';
    const i = openPath.lastIndexOf('/');
    return i === -1 ? '' : openPath.slice(0, i);
  }

  // Open the file picker, remembering which folder to upload into.
  function triggerUpload(dir: string) {
    uploadDir.current = dir;
    uploadInput.current?.click();
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const dir = uploadDir.current;
    try {
      const { written } = await api.uploadFiles(id, files, dir);
      await refreshTree();
      // Open the first uploaded text file (images just show in the tree).
      const firstText = written.find((p) => isText(p));
      if (firstText) await openFile(firstText);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      uploadDir.current = '';
      if (uploadInput.current) uploadInput.current.value = '';
    }
  }

  // --- SyncTeX --------------------------------------------------------------

  // Editor double-click -> highlight the matching spot in the PDF.
  async function handleForwardSync(line: number, column: number) {
    if (!openPath || extOf(openPath) !== '.tex') return;
    try {
      const hits = await api.synctexForward(id, openPath, line, column);
      if (hits.length === 0) {
        setError('SyncTeX: no PDF match. Recompile the project, then try again.');
        return;
      }
      setError(null);
      setPdfHighlight({ ...hits[0], nonce: ++syncNonce.current });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // PDF double-click -> open the source file and jump to the line.
  async function handleInverseSync(page: number, x: number, y: number) {
    try {
      const hit = await api.synctexInverse(id, page, x, y);
      if (!hit || !hit.line) return;
      if (hit.file && hit.file !== openPath) await openFile(hit.file);
      setRevealLine(hit.line);
      setRevealNonce((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // --- Claude assistant -----------------------------------------------------

  async function handleDiagnose() {
    if (!result || diagnosing) return;
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      const answer = await api.assistantDiagnose({
        log: result.log,
        errors: result.errors,
        mainFile: result.mainFile,
      });
      setDiagnosis(answer);
    } catch (e) {
      setDiagnosis(`⚠ ${(e as Error).message}`);
    } finally {
      setDiagnosing(false);
    }
  }

  // Reload the file tree and the open file from disk (after a history restore),
  // without saving the stale editor buffer back over the restored content.
  async function reloadFromDisk() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setTree(await api.getFileTree(id));
    if (openPath) {
      try {
        setContent(await api.readFile(id, openPath));
        setDirty(false);
      } catch {
        setOpenPath(null);
        setContent('');
        setDirty(false);
      }
    }
  }

  function handleAssistReplace(text: string) {
    if (!assist) return;
    setApplyEdit({ from: assist.from, to: assist.to, text });
    setApplyEditNonce((n) => n + 1);
    setAssist(null);
  }

  return (
    <div className="workspace">
      <header className="ws-header">
        <div className="ws-left">
          <Link to="/" className="back-link" title="All projects">
            ←
          </Link>
          <img className="logo-img-sm" src="/api/branding/logo" alt="Overgrass" />
          <strong>{project?.name ?? '…'}</strong>
          <span className="save-status small muted">
            {saving ? 'saving…' : dirty ? 'unsaved' : 'saved'}
          </span>
        </div>
        <div className="ws-actions">
          <button
            className="btn"
            title="Upload images/files into the current folder"
            onClick={() => triggerUpload(currentDir())}
          >
            ⬆ Upload
          </button>
          <input ref={uploadInput} type="file" multiple hidden onChange={handleUpload} />
          <a className="btn" href={api.exportUrl(id)}>
            ⬇ Download .zip
          </a>
          <button className="btn" onClick={() => setShowHistory(true)} title="Version history">
            🕘 History
          </button>
          <button className="btn" onClick={() => setShowLog((s) => !s)}>
            {result && (!result.success || result.errors.length > 0) ? '⚠ Logs' : 'Logs'}
          </button>
          <button
            className="btn btn-primary"
            onClick={recompile}
            disabled={compiling}
            title="Recompile (Ctrl/Cmd+S)"
          >
            {compiling ? '⏳ Compiling…' : '▶ Recompile'}
          </button>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="ws-body" ref={bodyRef}>
        <aside className="pane pane-files" style={{ width: filesWidth }}>
          <FileTree
            nodes={tree}
            selected={openPath}
            mainFile={project?.mainFile ?? null}
            onSelect={(n) => openFile(n.path)}
            onCreate={handleCreate}
            onRename={handleRename}
            onDelete={handleDelete}
            onSetMain={handleSetMain}
            onUpload={triggerUpload}
          />
        </aside>

        <div
          className="col-gutter"
          onMouseDown={startResize('files')}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
        />

        <section className="pane pane-editor">
          {openPath ? (
            isText(openPath) ? (
              <CodeEditor
                docKey={openPath}
                value={content}
                language={extOf(openPath) === '.tex' ? 'latex' : 'text'}
                onChange={handleChange}
                onDoubleClickLine={handleForwardSync}
                revealLine={revealLine}
                revealNonce={revealNonce}
                onContextRequest={(info) => setAssist(info)}
                applyEdit={applyEdit}
                applyEditNonce={applyEditNonce}
              />
            ) : isImage(openPath) ? (
              <div className="asset-preview">
                <img src={api.rawUrl(id, openPath)} alt={openPath} />
              </div>
            ) : (
              <div className="asset-preview muted">
                Binary file — <a href={api.rawUrl(id, openPath)} target="_blank" rel="noreferrer">open / download</a>
              </div>
            )
          ) : (
            <div className="asset-preview muted">Select a file to edit.</div>
          )}
        </section>

        <div
          className="col-gutter"
          onMouseDown={startResize('pdf')}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
        />

        <section className="pane pane-pdf" style={{ width: pdfWidth }}>
          <PdfViewer url={pdfUrl} highlight={pdfHighlight} onReverse={handleInverseSync} />
        </section>
      </div>

      {showLog && (
        <div className="log-panel">
          <div className="log-header">
            <span>
              Compilation log{' '}
              {result && (
                <span className={result.success ? (result.errors.length ? 'warn' : 'ok') : 'err'}>
                  {result.success
                    ? result.errors.length
                      ? `⚠ PDF produced with ${result.errors.length} error${result.errors.length > 1 ? 's' : ''} (${(result.durationMs / 1000).toFixed(1)}s, ${result.mainFile})`
                      : `✓ success (${(result.durationMs / 1000).toFixed(1)}s, ${result.mainFile})`
                    : '✗ no PDF produced'}
                </span>
              )}
            </span>
            <span className="log-header-actions">
              {result && (!result.success || result.errors.length > 0) && (
                <button className="btn btn-sm" onClick={handleDiagnose} disabled={diagnosing}>
                  {diagnosing ? '⏳ Diagnosing…' : '✦ Diagnose with Claude'}
                </button>
              )}
              <button className="icon-btn" onClick={() => setShowLog(false)}>
                ✕
              </button>
            </span>
          </div>
          {result && result.errors.length > 0 && (
            <ul className="log-errors">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {diagnosis && (
            <div className="log-diagnosis">
              <div className="log-diagnosis-head">
                <span>✦ Claude’s diagnosis</span>
                <button className="icon-btn" onClick={() => setDiagnosis(null)}>
                  ✕
                </button>
              </div>
              <div className="log-diagnosis-body">{diagnosis}</div>
            </div>
          )}
          <pre className="log-body">{result?.log ?? 'No log yet. Press Recompile.'}</pre>
        </div>
      )}

      {showHistory && (
        <HistoryPanel
          projectId={id}
          onRestored={reloadFromDisk}
          onClose={() => setShowHistory(false)}
        />
      )}

      {assist && (
        <AssistantPopup
          x={assist.x}
          y={assist.y}
          selection={assist.text}
          fileName={openPath ?? undefined}
          language={openPath && extOf(openPath) === '.tex' ? 'LaTeX' : 'text'}
          onReplace={handleAssistReplace}
          onClose={() => setAssist(null)}
        />
      )}
    </div>
  );
}

function findFirstTex(nodes: FileNode[]): string | null {
  for (const n of nodes) {
    if (n.type === 'file' && n.path.toLowerCase().endsWith('.tex')) return n.path;
    if (n.type === 'dir') {
      const found = findFirstTex(n.children ?? []);
      if (found) return found;
    }
  }
  return null;
}
