import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_DIRNAME, resolveInProject, resolveMainFile } from './store.js';

const execFileAsync = promisify(execFile);

export interface CompileResult {
  /** True when a PDF was produced (it may still contain non-fatal errors). */
  success: boolean;
  /** Project-relative path to the produced PDF (under .build/), if any. */
  pdfPath: string | null;
  /** Full latexmk / LaTeX log output. */
  log: string;
  /** Extracted LaTeX error lines (e.g. "root.tex:42: Undefined control sequence"). */
  errors: string[];
  mainFile: string | null;
  durationMs: number;
}

/** Pull out the human-meaningful error lines from a LaTeX log. */
function extractErrors(log: string): string[] {
  const errs: string[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.trimEnd();
    // file-line-error style ("./root.tex:42: message") or classic ("! message").
    if (/^(?:.+?:\d+: |! )/.test(line)) errs.push(line.trim());
  }
  // De-duplicate consecutive repeats and cap the list.
  return errs.filter((l, i) => l && l !== errs[i - 1]).slice(0, 50);
}

/** Pull out BibTeX/Biber problems from a .blg log (different format from .log). */
function extractBibErrors(blg: string): string[] {
  if (!blg) return [];
  const out: string[] = [];
  for (const raw of blg.split('\n')) {
    const l = raw.trim();
    if (/(Repeated entry|I couldn't open|I didn't find|^Warning--|^Sorry|error message|database entry)/.test(l)) {
      out.push(`bibtex: ${l}`);
    }
  }
  return out.filter((l, i) => l && l !== out[i - 1]).slice(0, 30);
}

let latexmkAvailable: boolean | null = null;

/** Check once whether latexmk is on PATH. */
export async function checkLatexmk(): Promise<boolean> {
  if (latexmkAvailable !== null) return latexmkAvailable;
  try {
    await execFileAsync('latexmk', ['--version']);
    latexmkAvailable = true;
  } catch {
    latexmkAvailable = false;
  }
  return latexmkAvailable;
}

const COMPILE_TIMEOUT_MS = 120_000;

/**
 * Compile a project with latexmk. Output (including the PDF) goes to .build/.
 * Resolves even on LaTeX errors — inspect `success` and `log`.
 */
export async function compileProject(id: string): Promise<CompileResult> {
  const started = Date.now();

  if (!(await checkLatexmk())) {
    return {
      success: false,
      pdfPath: null,
      errors: [],
      mainFile: null,
      durationMs: Date.now() - started,
      log:
        'latexmk was not found on PATH.\n\n' +
        'Install a TeX distribution, e.g. on Debian/Ubuntu:\n' +
        '  sudo apt-get install texlive-full latexmk\n\n' +
        'Then restart the Overgrass server.',
    };
  }

  const mainFile = await resolveMainFile(id);
  if (!mainFile) {
    return {
      success: false,
      pdfPath: null,
      errors: [],
      mainFile: null,
      durationMs: Date.now() - started,
      log: 'No .tex file found in this project. Add a file with \\documentclass to compile.',
    };
  }

  // resolveInProject(id, '.') already points at the project directory.
  const projectRoot = resolveInProject(id, '.');
  const buildDir = resolveInProject(id, BUILD_DIRNAME);
  fs.mkdirSync(buildDir, { recursive: true });

  const args = [
    '-pdf',
    '-synctex=1', // emit <base>.synctex.gz so we can map source <-> PDF
    '-interaction=nonstopmode',
    // No -halt-on-error: like Overleaf, push through recoverable errors and
    // still produce a best-effort PDF.
    '-file-line-error',
    // -f (force): keep going even if a tool (e.g. bibtex hitting a duplicate
    // .bib entry) fails, so latexmk still reruns and incorporates the .bbl
    // instead of leaving every citation undefined.
    '-f',
    `-outdir=${BUILD_DIRNAME}`,
    mainFile,
  ];

  const cwd = projectRoot;

  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn('latexmk', args, { cwd, env: process.env });

    const timer = setTimeout(() => {
      if (settled) return;
      out += `\n\n[Overgrass] Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s; aborted.\n`;
      child.kill('SIGKILL');
    }, COMPILE_TIMEOUT_MS);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, out: out + `\n[Overgrass] Failed to launch latexmk: ${err.message}\n` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

  // latexmk writes <basename>.pdf into the outdir.
  const base = path.basename(mainFile, path.extname(mainFile));
  const pdfAbs = path.join(buildDir, `${base}.pdf`);
  const pdfExists = fs.existsSync(pdfAbs);
  const pdfPath = pdfExists ? `${BUILD_DIRNAME}/${base}.pdf` : null;

  // Prefer the .log file written by LaTeX (richer than stdout) when present.
  let log = result.out;
  const logAbs = path.join(buildDir, `${base}.log`);
  if (fs.existsSync(logAbs)) {
    try {
      log = fs.readFileSync(logAbs, 'utf8');
    } catch {
      /* fall back to captured stdout */
    }
  }

  // Also read the BibTeX/Biber log so bibliography errors are visible.
  let blg = '';
  const blgAbs = path.join(buildDir, `${base}.blg`);
  if (fs.existsSync(blgAbs)) {
    try {
      blg = fs.readFileSync(blgAbs, 'utf8');
    } catch {
      /* ignore */
    }
  }
  const fullLog = blg ? `${log}\n\n===== BibTeX log (${base}.blg) =====\n${blg}` : log;

  // Success means "a PDF came out" — it may still carry non-fatal errors,
  // which we surface separately (Overleaf behaves the same way).
  const errors = [...extractErrors(`${log}\n${result.out}`), ...extractBibErrors(blg)];

  return {
    success: pdfExists,
    pdfPath,
    errors,
    mainFile,
    durationMs: Date.now() - started,
    log: fullLog,
  };
}
