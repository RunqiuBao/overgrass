import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './store.js';

/**
 * Claude assistant integration. Two billing paths, both server-side:
 *
 *  - subscription: a Claude Pro/Max OAuth token (`sk-ant-oat…`, from
 *    `claude setup-token`) drives the bundled Claude Code CLI (`claude -p`),
 *    billed against the subscription. Preferred when a token is present.
 *  - api: an Anthropic API key (`sk-ant-api…`) calls the Messages API,
 *    billed pay-per-token. Fallback.
 *
 * Credentials live in env vars first, else a config the user saved into the
 * data dir. They never reach the browser.
 */

const CONFIG_PATH = path.join(DATA_DIR, 'claude-config.json');
/** Optional model override. CLI accepts aliases (opus/sonnet/haiku); the API path needs a full id. */
const MODEL = process.env.OVERGRASS_CLAUDE_MODEL || '';
const API_MODEL = MODEL || 'claude-opus-4-8';
const CLI_TIMEOUT_MS = 120_000;

interface StoredConfig {
  apiKey?: string;
  oauthToken?: string;
}

function readConfig(): StoredConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as StoredConfig;
  } catch {
    return {};
  }
}

function envOAuth(): string | null {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
}
function envApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || process.env.OVERGRASS_ANTHROPIC_KEY || null;
}

export function getOAuthToken(): string | null {
  return envOAuth() || readConfig().oauthToken || null;
}
export function getApiKey(): string | null {
  return envApiKey() || readConfig().apiKey || null;
}

export type Mode = 'subscription' | 'api';

/** Subscription wins when both are available. */
export function activeMode(): Mode | null {
  if (getOAuthToken()) return 'subscription';
  if (getApiKey()) return 'api';
  return null;
}

export function isConfigured(): boolean {
  return activeMode() !== null;
}

export function status(): { configured: boolean; mode: Mode | null; source: 'env' | 'file' | null } {
  const mode = activeMode();
  let source: 'env' | 'file' | null = null;
  if (mode === 'subscription') source = envOAuth() ? 'env' : 'file';
  else if (mode === 'api') source = envApiKey() ? 'env' : 'file';
  return { configured: mode !== null, mode, source };
}

/** Save a credential, routed by prefix: `sk-ant-oat…` → subscription, else API key. */
export async function saveCredential(value: string): Promise<Mode> {
  const v = value.trim();
  const cfg = readConfig();
  const mode: Mode = v.startsWith('sk-ant-oat') ? 'subscription' : 'api';
  if (mode === 'subscription') cfg.oauthToken = v;
  else cfg.apiKey = v;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return mode;
}

export interface AskParams {
  selection: string;
  prompt: string;
  fileName?: string;
  language?: string;
}

const SYSTEM_PROMPT = [
  'You are an AI writing assistant embedded in a LaTeX editor (an Overleaf-like app).',
  'The user has selected a snippet of their document and given an instruction.',
  'Rewrite or transform the selected snippet according to the instruction.',
  'Return ONLY the replacement text that should take the place of the selection —',
  'no Markdown code fences, no preamble, no explanation, no commentary.',
  'Preserve LaTeX syntax and the surrounding style.',
  'If the instruction is a question rather than an edit, answer it concisely and directly.',
].join(' ');

function buildUserText({ selection, prompt, fileName, language }: AskParams): string {
  return (
    (fileName ? `File: ${fileName}\n` : '') +
    `Selected ${language ?? 'text'}:\n<<<SELECTION\n${selection}\nSELECTION>>>\n\n` +
    `Instruction: ${prompt}\n\n` +
    'Reply with only the replacement text.'
  );
}

/** Drop a leading/trailing ```fence``` if the model wrapped the whole reply. */
function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

export async function ask(params: AskParams): Promise<string> {
  const mode = activeMode();
  if (mode === 'subscription') return stripFences(await askViaCli(params));
  if (mode === 'api') return stripFences(await askViaApi(params));
  throw new Error('Claude is not configured. Add an API key or subscription token to start.');
}

// --- API key path (Messages API) -------------------------------------------

async function askViaApi(params: AskParams): Promise<string> {
  const apiKey = getApiKey()!;
  const client = new Anthropic({ apiKey });
  let resp;
  try {
    resp = await client.messages.create({
      model: API_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserText(params) }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Claude API key was rejected (401). Set a valid key and try again.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Claude rate limit hit (429). Wait a moment and try again.');
    }
    throw new Error(`Claude request failed: ${(err as Error).message}`);
  }
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// --- Subscription path (Claude Code CLI) -----------------------------------

interface CliResult {
  code: number | null;
  out: string;
  err: string;
}

function runClaude(args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let settled = false;
    let child;
    try {
      child = spawn('claude', args, { cwd, env });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, CLI_TIMEOUT_MS);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.end(input);
  });
}

async function askViaCli(params: AskParams): Promise<string> {
  const token = getOAuthToken()!;

  // CLAUDE_CODE_OAUTH_TOKEN is low in the CLI's auth precedence — a stray
  // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN would override it and bill the API
  // instead of the subscription. Strip them so the subscription token is used.
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const args = ['-p', '--output-format', 'json', '--system-prompt', SYSTEM_PROMPT];
  if (MODEL) args.push('--model', MODEL);

  // Run in a throwaway empty dir so the agent has nothing to read/modify.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'overgrass-claude-'));
  let result: CliResult;
  try {
    result = await runClaude(args, buildUserText(params), env, tmp);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(
        'Claude Code CLI not found in the container. Rebuild the image (overgrass restart) to install it, then add a subscription token from `claude setup-token`.',
      );
    }
    throw new Error(`Claude Code CLI failed to start: ${err.message}`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  if (result.code !== 0) {
    const detail = (result.err || result.out || '').trim().slice(0, 500);
    throw new Error(`Claude Code CLI error: ${detail || `exit ${result.code}`}`);
  }

  // --output-format json yields a single result object: { result, is_error, ... }
  try {
    const parsed = JSON.parse(result.out) as { result?: string; is_error?: boolean };
    if (parsed.is_error) {
      throw new Error(`Claude Code returned an error: ${parsed.result ?? 'unknown'}`);
    }
    return parsed.result ?? '';
  } catch {
    // Fall back to raw stdout if it wasn't JSON for some reason.
    return result.out.trim();
  }
}
