import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  listProjects,
  getProject,
  createProject,
  copyProject,
  renameProject,
  setMainFile,
  setTags,
  deleteProject,
  getFileTree,
  readFile,
  readFileBuffer,
  writeFile,
  createEntry,
  deleteEntry,
  renameEntry,
  isTextFile,
  importZip,
  exportZip,
  resolveInProject,
  DATA_DIR,
} from './store.js';
import { compileProject, checkLatexmk, currentPdfPath } from './compile.js';
import { forwardSearch, inverseSearch, checkSynctex } from './synctex.js';
import { ask as assistantAsk, diagnose as assistantDiagnose, status as assistantStatus, saveCredential as assistantSaveCredential } from './assistant.js';
import { listHistory, snapshot as historySnapshot, snapshotQuiet, restore as historyRestore } from './history.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the logo to serve, in priority order. Lets you replace the logo at
 * runtime (no rebuild): drop a file at $OVERGRASS_DATA/branding/logo.<ext>
 * (that folder is bind-mounted), or point OVERGRASS_LOGO at any file.
 */
function resolveLogoPath(): string | null {
  const candidates: string[] = [];
  if (process.env.OVERGRASS_LOGO) candidates.push(path.resolve(process.env.OVERGRASS_LOGO));
  for (const ext of ['png', 'svg', 'jpg', 'jpeg', 'webp', 'gif']) {
    candidates.push(path.join(DATA_DIR, 'branding', `logo.${ext}`));
  }
  // Bundled default shipped in the image / repo.
  candidates.push(path.resolve(__dirname, '../../resources/overgrass-logo.png'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Wrap async route handlers so rejections hit the error middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// --- Health / environment ---------------------------------------------------

app.get('/api/health', wrap(async (_req, res) => {
  res.json({ ok: true, latexmk: await checkLatexmk(), synctex: await checkSynctex() });
}));

// --- Claude assistant -------------------------------------------------------

app.get('/api/assistant/status', wrap(async (_req, res) => {
  res.json(assistantStatus());
}));

app.post('/api/assistant/key', wrap(async (req, res) => {
  const { apiKey } = req.body ?? {};
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    res.status(400).json({ error: 'Expected { apiKey }.' });
    return;
  }
  const mode = await assistantSaveCredential(apiKey);
  res.json({ ok: true, configured: true, mode });
}));

app.post('/api/assistant/ask', wrap(async (req, res) => {
  const { selection, prompt, fileName, language } = req.body ?? {};
  if (typeof selection !== 'string' || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Expected { selection, prompt }.' });
    return;
  }
  res.json({ options: await assistantAsk({ selection, prompt, fileName, language }) });
}));

app.post('/api/assistant/diagnose', wrap(async (req, res) => {
  const { log, errors, mainFile } = req.body ?? {};
  if (typeof log !== 'string' || !log.trim()) {
    res.status(400).json({ error: 'Expected { log }.' });
    return;
  }
  const answer = await assistantDiagnose({
    log,
    errors: Array.isArray(errors) ? errors.map(String) : undefined,
    mainFile: typeof mainFile === 'string' ? mainFile : undefined,
  });
  res.json({ answer });
}));

// Logo served at runtime (replaceable without rebuilding — see resolveLogoPath).
app.get('/api/branding/logo', (_req, res) => {
  const logo = resolveLogoPath();
  if (!logo) {
    res.status(404).json({ error: 'No logo configured.' });
    return;
  }
  // No-cache so swapping the file shows up on the next refresh.
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(logo);
});

// --- Projects ---------------------------------------------------------------

app.get('/api/projects', wrap(async (_req, res) => {
  res.json(await listProjects());
}));

app.post('/api/projects', wrap(async (req, res) => {
  const { name } = req.body ?? {};
  const meta = await createProject(typeof name === 'string' ? name : 'Untitled Project');
  await snapshotQuiet(meta.id, 'Project created');
  res.status(201).json(meta);
}));

app.get('/api/projects/:id', wrap(async (req, res) => {
  res.json(await getProject(req.params.id));
}));

app.patch('/api/projects/:id', wrap(async (req, res) => {
  const { name, mainFile, tags } = req.body ?? {};
  let meta = await getProject(req.params.id);
  if (typeof name === 'string') meta = await renameProject(req.params.id, name);
  if (typeof mainFile === 'string') meta = await setMainFile(req.params.id, mainFile);
  if (Array.isArray(tags)) meta = await setTags(req.params.id, tags.map(String));
  res.json(meta);
}));

app.post('/api/projects/:id/copy', wrap(async (req, res) => {
  const meta = await copyProject(req.params.id);
  await snapshotQuiet(meta.id, 'Project created (copy)');
  res.status(201).json(meta);
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  await deleteProject(req.params.id);
  res.status(204).end();
}));

// --- Import / export --------------------------------------------------------

app.post('/api/projects/import', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });
    return;
  }
  const fallback = req.file.originalname.replace(/\.zip$/i, '') || 'Imported Project';
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name : fallback;
  const meta = await importZip(req.file.buffer, name);
  await snapshotQuiet(meta.id, 'Imported project');
  res.status(201).json(meta);
}));

app.get('/api/projects/:id/export', wrap(async (req, res) => {
  const meta = await getProject(req.params.id);
  const buf = await exportZip(req.params.id);
  const safeName = meta.name.replace(/[^a-z0-9-_]+/gi, '_') || 'project';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  res.send(buf);
}));

// --- File tree --------------------------------------------------------------

app.get('/api/projects/:id/files', wrap(async (req, res) => {
  res.json(await getFileTree(req.params.id));
}));

app.get('/api/projects/:id/file', wrap(async (req, res) => {
  const rel = String(req.query.path ?? '');
  if (!rel) {
    res.status(400).json({ error: 'Missing path query parameter.' });
    return;
  }
  if (isTextFile(rel)) {
    res.json({ path: rel, encoding: 'utf8', content: await readFile(req.params.id, rel) });
  } else {
    // Binary asset: stream it directly (used for image previews).
    const abs = resolveInProject(req.params.id, rel);
    res.sendFile(abs);
  }
}));

app.get('/api/projects/:id/raw', wrap(async (req, res) => {
  const rel = String(req.query.path ?? '');
  if (!rel) {
    res.status(400).json({ error: 'Missing path query parameter.' });
    return;
  }
  res.sendFile(resolveInProject(req.params.id, rel));
}));

app.put('/api/projects/:id/file', wrap(async (req, res) => {
  const { path: rel, content } = req.body ?? {};
  if (typeof rel !== 'string' || typeof content !== 'string') {
    res.status(400).json({ error: 'Expected { path, content }.' });
    return;
  }
  await writeFile(req.params.id, rel, content);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/file', wrap(async (req, res) => {
  const { path: rel, type } = req.body ?? {};
  if (typeof rel !== 'string' || (type !== 'file' && type !== 'dir')) {
    res.status(400).json({ error: 'Expected { path, type: "file" | "dir" }.' });
    return;
  }
  await createEntry(req.params.id, rel, type);
  res.status(201).json({ ok: true });
}));

app.post('/api/projects/:id/rename', wrap(async (req, res) => {
  const { from, to } = req.body ?? {};
  if (typeof from !== 'string' || typeof to !== 'string') {
    res.status(400).json({ error: 'Expected { from, to }.' });
    return;
  }
  await renameEntry(req.params.id, from, to);
  res.json({ ok: true });
}));

app.delete('/api/projects/:id/file', wrap(async (req, res) => {
  const rel = String(req.query.path ?? '');
  if (!rel) {
    res.status(400).json({ error: 'Missing path query parameter.' });
    return;
  }
  await deleteEntry(req.params.id, rel);
  res.status(204).end();
}));

app.post('/api/projects/:id/upload', upload.array('files'), wrap(async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  const dest = typeof req.body?.dir === 'string' ? req.body.dir : '';
  const written: string[] = [];
  for (const f of files) {
    const rel = dest ? `${dest.replace(/\/$/, '')}/${f.originalname}` : f.originalname;
    const abs = resolveInProject(req.params.id, rel);
    await import('node:fs/promises').then((fsp) =>
      fsp.mkdir(path.dirname(abs), { recursive: true }).then(() => fsp.writeFile(abs, f.buffer)),
    );
    written.push(rel);
  }
  res.status(201).json({ written });
}));

// --- Compilation ------------------------------------------------------------

app.post('/api/projects/:id/compile', wrap(async (req, res) => {
  // Checkpoint the source on each compile (only commits if it changed).
  await snapshotQuiet(req.params.id, 'Auto-saved on compile');
  res.json(await compileProject(req.params.id));
}));

// Report the already-built PDF (from a previous compile), so the editor can
// show it immediately on open without forcing a recompile.
app.get('/api/projects/:id/pdf-current', wrap(async (req, res) => {
  res.json({ pdfPath: await currentPdfPath(req.params.id) });
}));

// --- History ----------------------------------------------------------------

app.get('/api/projects/:id/history', wrap(async (req, res) => {
  res.json(await listHistory(req.params.id));
}));

app.post('/api/projects/:id/history', wrap(async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message : 'Manual snapshot';
  res.status(201).json({ version: await historySnapshot(req.params.id, message) });
}));

app.post('/api/projects/:id/history/restore', wrap(async (req, res) => {
  const { hash } = req.body ?? {};
  if (typeof hash !== 'string') {
    res.status(400).json({ error: 'Expected { hash }.' });
    return;
  }
  await historyRestore(req.params.id, hash);
  res.json({ ok: true });
}));

// --- SyncTeX (source <-> PDF) ----------------------------------------------

app.get('/api/projects/:id/synctex/forward', wrap(async (req, res) => {
  const file = String(req.query.file ?? '');
  const line = Number(req.query.line);
  const column = Number(req.query.column ?? 0) || 0;
  if (!file || !Number.isFinite(line)) {
    res.status(400).json({ error: 'Expected file and line query parameters.' });
    return;
  }
  res.json({ hits: await forwardSearch(req.params.id, file, line, column) });
}));

app.get('/api/projects/:id/synctex/inverse', wrap(async (req, res) => {
  const page = Number(req.query.page);
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  if (![page, x, y].every(Number.isFinite)) {
    res.status(400).json({ error: 'Expected page, x, y query parameters.' });
    return;
  }
  res.json(await inverseSearch(req.params.id, page, x, y));
}));

app.get('/api/projects/:id/pdf', wrap(async (req, res) => {
  const rel = String(req.query.path ?? '');
  if (!rel) {
    res.status(400).json({ error: 'Missing path query parameter.' });
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(resolveInProject(req.params.id, rel));
}));

// --- Static client (production) ---------------------------------------------
// When the built front end is present, serve it from the same origin so the
// whole app runs on a single port (used by the Docker image).

const CLIENT_DIST = process.env.CLIENT_DIST
  ? path.resolve(process.env.CLIENT_DIST)
  : path.resolve(__dirname, '../../client/dist');

if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback: any non-API GET returns index.html so client routing works.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
  console.log(`  serving client from ${CLIENT_DIST}`);
}

// --- Errors -----------------------------------------------------------------

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[overgrass]', err);
  const msg = err?.message ?? 'Internal error';
  const code = /not found|ENOENT/i.test(msg) ? 404 : 400;
  res.status(code).json({ error: msg });
});

app.listen(PORT, async () => {
  const hasLatex = await checkLatexmk();
  console.log(`\n  Overgrass server listening on http://localhost:${PORT}`);
  console.log(`  latexmk: ${hasLatex ? 'available ✓' : 'NOT found ✗  (install texlive-full to compile)'}\n`);
});
