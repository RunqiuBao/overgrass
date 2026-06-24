import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

/**
 * On-disk project storage.
 *
 * Layout:
 *   data/projects/<id>/                <- project root (the LaTeX source tree)
 *   data/projects/<id>/.overgrass.json <- project metadata (name, mainFile, timestamps)
 *   data/projects/<id>/.build/         <- latexmk output (hidden from the file tree)
 */

const DATA_DIR = process.env.OVERGRASS_DATA
  ? path.resolve(process.env.OVERGRASS_DATA)
  : path.resolve(process.cwd(), '..', 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

export const BUILD_DIRNAME = '.build';
const META_FILENAME = '.overgrass.json';

/** Names that never show up in the file tree and can't be edited directly. */
const HIDDEN = new Set([META_FILENAME, BUILD_DIRNAME, '.git', '.DS_Store']);

export interface ProjectMeta {
  id: string;
  name: string;
  mainFile: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FileNode {
  name: string;
  path: string; // POSIX-style path relative to the project root
  type: 'file' | 'dir';
  children?: FileNode[];
}

function ensureDirs() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

function projectDir(id: string): string {
  return path.join(PROJECTS_DIR, id);
}

function metaPath(id: string): string {
  return path.join(projectDir(id), META_FILENAME);
}

function newId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Resolve a project-relative path to an absolute path, guarding against
 * traversal (`..`) escaping the project root.
 */
export function resolveInProject(id: string, relPath: string): string {
  const root = projectDir(id);
  const normalized = path
    .normalize(relPath)
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^[/\\]+/, '');
  const abs = path.join(root, normalized);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes project root');
  }
  return abs;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

async function readMeta(id: string): Promise<ProjectMeta> {
  const raw = await fsp.readFile(metaPath(id), 'utf8');
  const meta = JSON.parse(raw) as ProjectMeta;
  // Backfill fields added after a project was created.
  if (!Array.isArray(meta.tags)) meta.tags = [];
  return meta;
}

async function writeMeta(meta: ProjectMeta): Promise<void> {
  await fsp.writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8');
}

async function touch(id: string): Promise<void> {
  try {
    const meta = await readMeta(id);
    meta.updatedAt = new Date().toISOString();
    await writeMeta(meta);
  } catch {
    /* metadata might not exist yet during import */
  }
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<ProjectMeta[]> {
  ensureDirs();
  const entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  const metas: ProjectMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      metas.push(await readMeta(entry.name));
    } catch {
      /* skip directories without valid metadata */
    }
  }
  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return metas;
}

export async function getProject(id: string): Promise<ProjectMeta> {
  return readMeta(id);
}

export async function createProject(name: string): Promise<ProjectMeta> {
  ensureDirs();
  const id = newId();
  await fsp.mkdir(projectDir(id), { recursive: true });
  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    id,
    name: name.trim() || 'Untitled Project',
    mainFile: 'main.tex',
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeMeta(meta);
  // Seed with a starter document so a fresh project compiles immediately.
  await fsp.writeFile(resolveInProject(id, 'main.tex'), STARTER_TEX, 'utf8');
  return meta;
}

export async function renameProject(id: string, name: string): Promise<ProjectMeta> {
  const meta = await readMeta(id);
  meta.name = name.trim() || meta.name;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(meta);
  return meta;
}

export async function setMainFile(id: string, mainFile: string): Promise<ProjectMeta> {
  const meta = await readMeta(id);
  meta.mainFile = mainFile;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(meta);
  return meta;
}

export async function setTags(id: string, tags: string[]): Promise<ProjectMeta> {
  const meta = await readMeta(id);
  // Normalize: trim, drop empties, de-duplicate (case-insensitive), keep order.
  const seen = new Set<string>();
  meta.tags = tags
    .map((t) => t.trim())
    .filter((t) => {
      const k = t.toLowerCase();
      if (!t || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  meta.updatedAt = new Date().toISOString();
  await writeMeta(meta);
  return meta;
}

export async function deleteProject(id: string): Promise<void> {
  await fsp.rm(projectDir(id), { recursive: true, force: true });
}

/** Duplicate a project (source files only, excluding build output). */
export async function copyProject(id: string): Promise<ProjectMeta> {
  ensureDirs();
  const src = projectDir(id);
  const meta = await readMeta(id);
  const newIdStr = newId();
  const dest = projectDir(newIdStr);
  await fsp.cp(src, dest, { recursive: true });
  // Drop the copied build artifacts so the duplicate compiles fresh.
  await fsp.rm(path.join(dest, BUILD_DIRNAME), { recursive: true, force: true });
  const now = new Date().toISOString();
  const newMeta: ProjectMeta = {
    id: newIdStr,
    name: `${meta.name} (copy)`,
    mainFile: meta.mainFile,
    tags: [...meta.tags],
    createdAt: now,
    updatedAt: now,
  };
  await writeMeta(newMeta); // overwrites the .overgrass.json copied from the source
  return newMeta;
}

// ---------------------------------------------------------------------------
// File tree + file operations
// ---------------------------------------------------------------------------

export async function getFileTree(id: string): Promise<FileNode[]> {
  const root = projectDir(id);
  async function walk(dir: string): Promise<FileNode[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      if (HIDDEN.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: rel, type: 'dir', children: await walk(abs) });
      } else {
        nodes.push({ name: entry.name, path: rel, type: 'file' });
      }
    }
    // Directories first, then files, each alphabetically.
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }
  return walk(root);
}

const TEXT_EXTENSIONS = new Set([
  '.tex', '.txt', '.bib', '.cls', '.sty', '.md', '.markdown', '.json', '.yml',
  '.yaml', '.bst', '.def', '.tikz', '.csv', '.log', '.gitignore', '.cfg', '.toml',
]);

export function isTextFile(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return ext === '';
}

export async function readFile(id: string, relPath: string): Promise<string> {
  const abs = resolveInProject(id, relPath);
  return fsp.readFile(abs, 'utf8');
}

export async function readFileBuffer(id: string, relPath: string): Promise<Buffer> {
  const abs = resolveInProject(id, relPath);
  return fsp.readFile(abs);
}

export async function writeFile(id: string, relPath: string, content: string): Promise<void> {
  const abs = resolveInProject(id, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  await touch(id);
}

export async function writeFileBuffer(id: string, relPath: string, buf: Buffer): Promise<void> {
  const abs = resolveInProject(id, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, buf);
  await touch(id);
}

export async function createEntry(
  id: string,
  relPath: string,
  type: 'file' | 'dir',
): Promise<void> {
  const abs = resolveInProject(id, relPath);
  if (type === 'dir') {
    await fsp.mkdir(abs, { recursive: true });
  } else {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const exists = fs.existsSync(abs);
    if (!exists) await fsp.writeFile(abs, '', 'utf8');
  }
  await touch(id);
}

export async function deleteEntry(id: string, relPath: string): Promise<void> {
  const abs = resolveInProject(id, relPath);
  await fsp.rm(abs, { recursive: true, force: true });
  await touch(id);
}

export async function renameEntry(id: string, from: string, to: string): Promise<void> {
  const absFrom = resolveInProject(id, from);
  const absTo = resolveInProject(id, to);
  await fsp.mkdir(path.dirname(absTo), { recursive: true });
  await fsp.rename(absFrom, absTo);
  await touch(id);
}

// ---------------------------------------------------------------------------
// Main-file detection
// ---------------------------------------------------------------------------

/** Find the project's main .tex file: explicit metadata, else main.tex, else
 *  the first .tex containing \documentclass. */
export async function resolveMainFile(id: string): Promise<string | null> {
  const meta = await readMeta(id);
  if (meta.mainFile && fs.existsSync(resolveInProject(id, meta.mainFile))) {
    return meta.mainFile;
  }
  const texFiles: string[] = [];
  function collect(nodes: FileNode[]) {
    for (const n of nodes) {
      if (n.type === 'dir') collect(n.children ?? []);
      else if (n.path.toLowerCase().endsWith('.tex')) texFiles.push(n.path);
    }
  }
  collect(await getFileTree(id));
  if (texFiles.length === 0) return null;
  const main = texFiles.find((f) => f.toLowerCase() === 'main.tex');
  if (main) return main;
  for (const f of texFiles) {
    const content = await readFile(id, f);
    if (/\\documentclass/.test(content)) return f;
  }
  return texFiles[0];
}

// ---------------------------------------------------------------------------
// Zip import / export
// ---------------------------------------------------------------------------

/** Import an Overleaf .zip export as a new project. */
export async function importZip(zipBuffer: Buffer, name: string): Promise<ProjectMeta> {
  ensureDirs();
  const id = newId();
  const dir = projectDir(id);
  await fsp.mkdir(dir, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Overleaf zips sometimes nest everything inside a single top-level folder.
  // Detect and strip that common prefix so files land at the project root.
  const topLevels = new Set<string>();
  for (const e of entries) {
    const parts = e.entryName.split('/').filter(Boolean);
    if (parts.length > 0) topLevels.add(parts[0]);
  }
  const onlyDir =
    topLevels.size === 1 && entries.every((e) => e.isDirectory || e.entryName.includes('/'));
  const prefix = onlyDir ? `${[...topLevels][0]}/` : '';

  for (const e of entries) {
    if (e.isDirectory) continue;
    let entryName = e.entryName;
    if (prefix && entryName.startsWith(prefix)) entryName = entryName.slice(prefix.length);
    if (!entryName || entryName.startsWith('__MACOSX/')) continue;
    const target = resolveInProject(id, entryName);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, e.getData());
  }

  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    id,
    name: name.trim() || 'Imported Project',
    mainFile: null,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeMeta(meta);
  meta.mainFile = await resolveMainFile(id);
  await writeMeta(meta);
  return meta;
}

/** Export the whole project (source files, excluding build output) as a zip. */
export async function exportZip(id: string): Promise<Buffer> {
  const root = projectDir(id);
  const zip = new AdmZip();
  function add(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (HIDDEN.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) add(abs);
      else zip.addLocalFile(abs, toPosix(path.relative(root, path.dirname(abs))));
    }
  }
  add(root);
  return zip.toBuffer();
}

const STARTER_TEX = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}

\\title{Untitled Project}
\\author{}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}
Welcome to your local Overleaf! Edit this file and click
\\textbf{Recompile} to render the PDF.

The mass--energy equivalence is
\\begin{equation}
  E = mc^2.
\\end{equation}

\\end{document}
`;

export { PROJECTS_DIR, DATA_DIR };
