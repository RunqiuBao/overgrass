import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveInProject } from './store.js';

const AUTOSAVE_BRANCH = 'overgrass-autosave';
const AUTOSAVE_REF = `refs/heads/${AUTOSAVE_BRANCH}`;

/**
 * Per-project version history backed by a hidden Git repo in each project dir.
 *
 *  - Build output (.build/) and metadata (.overgrass.json) are excluded via
 *    .git/info/exclude, so history tracks only source and nothing extra appears
 *    in the file tree (the file tree already hides .git).
 *  - Snapshots are commits; a snapshot only commits when something changed.
 *  - Rollback is non-destructive: current state is snapshotted first, then the
 *    chosen version's tree is written as a NEW commit.
 */

const execFileAsync = promisify(execFile);

function repoDir(id: string): string {
  return resolveInProject(id, '.');
}

let gitAvailable: boolean | null = null;
export async function checkGit(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  try {
    await execFileAsync('git', ['--version']);
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function parseLog(out: string): Version[] {
  if (!out.trim()) return [];
  return out.split('\n').map((line) => {
    const [hash, ts, ...rest] = line.split('\x1f');
    return {
      hash,
      date: new Date(Number(ts) * 1000).toISOString(),
      message: rest.join('\x1f'),
    };
  });
}

async function ensureRepo(id: string): Promise<string> {
  if (!(await checkGit())) {
    throw new Error('git is not installed on the server, so project history is unavailable.');
  }
  const cwd = repoDir(id);
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    await git(cwd, ['init', '-q']);
    await git(cwd, ['config', 'user.email', 'overgrass@localhost']);
    await git(cwd, ['config', 'user.name', 'Overgrass']);
    await git(cwd, ['config', 'commit.gpgsign', 'false']);
    // Keep build output and metadata out of history without a visible .gitignore.
    await fsp.writeFile(path.join(cwd, '.git', 'info', 'exclude'), '.build/\n.overgrass.json\n');
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-q', '--allow-empty', '-m', 'Initial snapshot']);
  }
  return cwd;
}

export interface Version {
  hash: string;
  date: string; // ISO
  message: string;
}

/** Commit the current source if it changed. Returns the new version, or null. */
export async function snapshot(id: string, message: string): Promise<Version | null> {
  const cwd = await ensureRepo(id);
  await git(cwd, ['add', '-A']);
  const status = await git(cwd, ['status', '--porcelain']);
  if (!status.trim()) return null; // nothing changed
  await git(cwd, ['commit', '-q', '-m', message.trim() || 'Snapshot']);
  const [latest] = await listHistory(id, 1);
  return latest ?? null;
}

/** Best-effort snapshot that never throws (used on the compile path). */
export async function snapshotQuiet(id: string, message: string): Promise<void> {
  try {
    await snapshot(id, message);
  } catch {
    /* history is non-critical — ignore (e.g. git missing) */
  }
}

export async function listHistory(id: string, limit = 200): Promise<Version[]> {
  const cwd = await ensureRepo(id);
  // Unit-separator (\x1f) between fields; one commit per line.
  return parseLog(await git(cwd, ['log', `--max-count=${limit}`, '--pretty=format:%H%x1f%ct%x1f%s']));
}

/** Commits on the auto-save branch (the every-2-min safety net). */
export async function listAutosaves(id: string, limit = 100): Promise<Version[]> {
  const cwd = await ensureRepo(id);
  const exists = (await git(cwd, ['rev-parse', '-q', '--verify', AUTOSAVE_REF]).catch(() => '')).trim();
  if (!exists) return [];
  // `--not HEAD` keeps only the auto-save-exclusive commits (drops the main-branch
  // ancestor they branched from).
  return parseLog(
    await git(cwd, [
      'log',
      AUTOSAVE_BRANCH,
      '--not',
      'HEAD',
      `--max-count=${limit}`,
      '--pretty=format:%H%x1f%ct%x1f%s',
    ]),
  );
}

/**
 * Commit the current working tree to the auto-save branch IF it differs from the
 * last auto-save and from the main branch tip. Uses a throwaway index + git
 * plumbing, so it never disturbs the working branch, HEAD, or checked-out files.
 * Returns the new version, or null when there was nothing new to save.
 */
export async function autosave(id: string): Promise<Version | null> {
  const cwd = await ensureRepo(id);
  const tmpIndex = path.join(os.tmpdir(), `overgrass-autosave-${id}.index`);
  await fsp.rm(tmpIndex, { force: true }).catch(() => {});
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    // Stage the full working tree into the temp index (.build/.overgrass.json excluded).
    await git(cwd, ['add', '-A'], env);
    const tree = (await git(cwd, ['write-tree'], env)).trim();

    const lastAuto = (await git(cwd, ['rev-parse', '-q', '--verify', AUTOSAVE_REF]).catch(() => '')).trim();
    const head = (await git(cwd, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => '')).trim();
    const treeOf = async (commit: string) =>
      commit ? (await git(cwd, ['rev-parse', `${commit}^{tree}`]).catch(() => '')).trim() : '';
    const autoTree = await treeOf(lastAuto);
    const headTree = await treeOf(head);

    // Nothing new if it already matches the latest auto-save or the main tip.
    if (tree === autoTree || tree === headTree) return null;

    const msg = 'Auto-save';
    const parent = lastAuto || head;
    const commitArgs = ['commit-tree', tree];
    if (parent) commitArgs.push('-p', parent);
    commitArgs.push('-m', msg);
    const commit = (await git(cwd, commitArgs)).trim();
    await git(cwd, ['update-ref', AUTOSAVE_REF, commit]);
    return { hash: commit, date: new Date().toISOString(), message: msg };
  } finally {
    await fsp.rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/** Non-destructively restore the project to a previous version. */
export async function restore(id: string, hash: string): Promise<void> {
  if (!/^[0-9a-fA-F]{7,40}$/.test(hash)) throw new Error('Invalid version id.');
  const cwd = await ensureRepo(id);
  await git(cwd, ['cat-file', '-e', `${hash}^{commit}`]).catch(() => {
    throw new Error('Version not found.');
  });
  // 1. Preserve whatever is there now so the rollback itself is reversible.
  await snapshot(id, 'Auto-snapshot before rollback');
  // 2. Make the working tree + index exactly match the chosen commit's tree...
  await git(cwd, ['read-tree', hash]);
  await git(cwd, ['checkout-index', '-f', '-a']);
  await git(cwd, ['clean', '-fd']); // remove files added after that version (keeps excluded .build/.overgrass.json)
  // 3. ...and record it as a new commit on top of history.
  await git(cwd, ['commit', '-q', '--allow-empty', '-m', `Roll back to ${hash.slice(0, 8)}`]);
}
