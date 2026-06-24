import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_DIRNAME, resolveInProject, resolveMainFile } from './store.js';

const execFileAsync = promisify(execFile);

/**
 * SyncTeX bridge. Wraps the `synctex` CLI (ships with TeX Live) to map between
 * source positions and PDF positions, in both directions.
 *
 * Coordinates use the PDF page's top-left origin with y increasing downward
 * (the same convention PDF.js viewports use), in PDF points.
 *   - forward (source -> PDF): box is { h (left), v (baseline), W, H }.
 *   - inverse (PDF -> source): input point is { x, y } in points.
 */

export interface ForwardHit {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

export interface InverseHit {
  file: string | null; // project-relative path, or null if unresolved
  line: number;
  column: number;
}

let synctexAvailable: boolean | null = null;

export async function checkSynctex(): Promise<boolean> {
  if (synctexAvailable !== null) return synctexAvailable;
  try {
    await execFileAsync('synctex', ['help']);
    synctexAvailable = true;
  } catch {
    synctexAvailable = false;
  }
  return synctexAvailable;
}

function projectRoot(id: string): string {
  // resolveInProject(id, '.') already points at the project directory.
  return resolveInProject(id, '.');
}

/** Resolve the build PDF (project-relative) for a project, if it exists. */
async function buildPdf(id: string): Promise<string | null> {
  const mainFile = await resolveMainFile(id);
  if (!mainFile) return null;
  const base = path.basename(mainFile, path.extname(mainFile));
  const rel = `${BUILD_DIRNAME}/${base}.pdf`;
  return fs.existsSync(path.join(projectRoot(id), rel)) ? rel : null;
}

function num(line: string, key: string): number | null {
  const m = line.match(new RegExp(`^${key}:(-?[0-9.]+)`));
  return m ? Number(m[1]) : null;
}

function parseForward(stdout: string): ForwardHit[] {
  const hits: ForwardHit[] = [];
  let cur: Partial<ForwardHit> | null = null;
  const flush = () => {
    if (cur && cur.page != null && cur.h != null && cur.v != null) {
      hits.push({
        page: cur.page,
        x: cur.x ?? cur.h!,
        y: cur.y ?? cur.v!,
        h: cur.h!,
        v: cur.v!,
        W: cur.W ?? 0,
        H: cur.H ?? 0,
      });
    }
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('Page:')) {
      flush();
      cur = { page: num(line, 'Page') ?? undefined };
    } else if (cur) {
      const x = num(line, 'x');
      const y = num(line, 'y');
      const h = num(line, 'h');
      const v = num(line, 'v');
      const W = num(line, 'W');
      const H = num(line, 'H');
      if (x != null) cur.x = x;
      if (y != null) cur.y = y;
      if (h != null) cur.h = h;
      if (v != null) cur.v = v;
      if (W != null) cur.W = W;
      if (H != null) cur.H = H;
    }
  }
  flush();
  return hits;
}

/** Source -> PDF. `file` is project-relative (as recorded at compile time). */
export async function forwardSearch(
  id: string,
  file: string,
  line: number,
  column = 0,
): Promise<ForwardHit[]> {
  if (!(await checkSynctex())) return [];
  const pdf = await buildPdf(id);
  if (!pdf) return [];
  const cwd = projectRoot(id);
  try {
    const { stdout } = await execFileAsync(
      'synctex',
      ['view', '-i', `${line}:${column}:${file}`, '-o', pdf],
      { cwd },
    );
    return parseForward(stdout);
  } catch {
    return [];
  }
}

/** PDF -> source. x,y are PDF points from the page's top-left. */
export async function inverseSearch(
  id: string,
  page: number,
  x: number,
  y: number,
): Promise<InverseHit | null> {
  if (!(await checkSynctex())) return null;
  const pdf = await buildPdf(id);
  if (!pdf) return null;
  const cwd = projectRoot(id);
  try {
    const { stdout } = await execFileAsync(
      'synctex',
      ['edit', '-o', `${page}:${x}:${y}:${pdf}`],
      { cwd },
    );
    let inputAbs: string | null = null;
    let lineNo = 0;
    let col = 0;
    for (const raw of stdout.split('\n')) {
      const lineStr = raw.trim();
      if (lineStr.startsWith('Input:')) inputAbs = lineStr.slice('Input:'.length);
      else {
        const l = num(lineStr, 'Line');
        const c = num(lineStr, 'Column');
        if (l != null) lineNo = l;
        if (c != null) col = c;
      }
    }
    if (!inputAbs) return { file: null, line: lineNo, column: col };
    // Normalize to a project-relative POSIX path.
    const abs = path.isAbsolute(inputAbs) ? inputAbs : path.resolve(cwd, inputAbs);
    let rel = path.relative(cwd, abs);
    if (rel.startsWith('..') || rel === '') rel = path.basename(inputAbs);
    return { file: rel.split(path.sep).join('/'), line: lineNo, column: col };
  } catch {
    return null;
  }
}
