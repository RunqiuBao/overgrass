import type { CompileResult, FileNode, ForwardHit, InverseHit, ProjectMeta, Version } from './types';

const BASE = '/api';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  async health(): Promise<{ ok: boolean; latexmk: boolean }> {
    return json(await fetch(`${BASE}/health`));
  },

  // Projects
  async listProjects(): Promise<ProjectMeta[]> {
    return json(await fetch(`${BASE}/projects`));
  },
  async getProject(id: string): Promise<ProjectMeta> {
    return json(await fetch(`${BASE}/projects/${id}`));
  },
  async createProject(name: string): Promise<ProjectMeta> {
    return json(
      await fetch(`${BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
  },
  async updateProject(
    id: string,
    patch: Partial<Pick<ProjectMeta, 'name' | 'mainFile' | 'tags'>>,
  ): Promise<ProjectMeta> {
    return json(
      await fetch(`${BASE}/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
  },
  async copyProject(id: string): Promise<ProjectMeta> {
    return json(await fetch(`${BASE}/projects/${id}/copy`, { method: 'POST' }));
  },
  async deleteProject(id: string): Promise<void> {
    const res = await fetch(`${BASE}/projects/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Failed to delete project (${res.status})`);
  },
  async importZip(file: File, name?: string): Promise<ProjectMeta> {
    const form = new FormData();
    form.append('file', file);
    if (name) form.append('name', name);
    return json(await fetch(`${BASE}/projects/import`, { method: 'POST', body: form }));
  },
  exportUrl(id: string): string {
    return `${BASE}/projects/${id}/export`;
  },

  // Files
  async getFileTree(id: string): Promise<FileNode[]> {
    return json(await fetch(`${BASE}/projects/${id}/files`));
  },
  async readFile(id: string, path: string): Promise<string> {
    const res = await fetch(`${BASE}/projects/${id}/file?path=${encodeURIComponent(path)}`);
    const data = await json<{ content: string }>(res);
    return data.content;
  },
  async writeFile(id: string, path: string, content: string): Promise<void> {
    await json(
      await fetch(`${BASE}/projects/${id}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      }),
    );
  },
  async createEntry(id: string, path: string, type: 'file' | 'dir'): Promise<void> {
    await json(
      await fetch(`${BASE}/projects/${id}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, type }),
      }),
    );
  },
  async renameEntry(id: string, from: string, to: string): Promise<void> {
    await json(
      await fetch(`${BASE}/projects/${id}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      }),
    );
  },
  async deleteEntry(id: string, path: string): Promise<void> {
    const res = await fetch(`${BASE}/projects/${id}/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`Failed to delete (${res.status})`);
  },
  async uploadFiles(id: string, files: FileList | File[], dir = ''): Promise<{ written: string[] }> {
    const form = new FormData();
    for (const f of Array.from(files)) form.append('files', f);
    if (dir) form.append('dir', dir);
    return json(await fetch(`${BASE}/projects/${id}/upload`, { method: 'POST', body: form }));
  },
  rawUrl(id: string, path: string): string {
    return `${BASE}/projects/${id}/raw?path=${encodeURIComponent(path)}`;
  },

  // Compile
  async compile(id: string): Promise<CompileResult> {
    return json(await fetch(`${BASE}/projects/${id}/compile`, { method: 'POST' }));
  },
  pdfUrl(id: string, pdfPath: string): string {
    return `${BASE}/projects/${id}/pdf?path=${encodeURIComponent(pdfPath)}`;
  },
  /** Project-relative path to the last-built PDF, or null if none exists yet. */
  async currentPdf(id: string): Promise<string | null> {
    const data = await json<{ pdfPath: string | null }>(
      await fetch(`${BASE}/projects/${id}/pdf-current`),
    );
    return data.pdfPath;
  },

  // Claude assistant
  async assistantStatus(): Promise<{
    configured: boolean;
    mode: 'subscription' | 'api' | null;
    source: 'env' | 'file' | null;
  }> {
    return json(await fetch(`${BASE}/assistant/status`));
  },
  async assistantSetKey(apiKey: string): Promise<void> {
    await json(
      await fetch(`${BASE}/assistant/key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      }),
    );
  },
  async assistantAsk(params: {
    selection: string;
    prompt: string;
    fileName?: string;
    language?: string;
  }): Promise<string[]> {
    const data = await json<{ options: string[] }>(
      await fetch(`${BASE}/assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }),
    );
    return data.options;
  },
  async assistantDiagnose(params: {
    log: string;
    errors?: string[];
    mainFile?: string | null;
  }): Promise<string> {
    const data = await json<{ answer: string }>(
      await fetch(`${BASE}/assistant/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }),
    );
    return data.answer;
  },

  // History
  async listHistory(id: string, branch?: 'autosave'): Promise<Version[]> {
    const q = branch ? `?branch=${branch}` : '';
    return json(await fetch(`${BASE}/projects/${id}/history${q}`));
  },
  async autosave(id: string): Promise<{ saved: boolean; version: Version | null }> {
    return json(await fetch(`${BASE}/projects/${id}/autosave`, { method: 'POST' }));
  },
  async snapshotVersion(id: string, message: string): Promise<Version | null> {
    const data = await json<{ version: Version | null }>(
      await fetch(`${BASE}/projects/${id}/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      }),
    );
    return data.version;
  },
  async restoreVersion(id: string, hash: string): Promise<void> {
    await json(
      await fetch(`${BASE}/projects/${id}/history/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      }),
    );
  },

  // SyncTeX
  async synctexForward(id: string, file: string, line: number, column = 0): Promise<ForwardHit[]> {
    const q = `file=${encodeURIComponent(file)}&line=${line}&column=${column}`;
    const data = await json<{ hits: ForwardHit[] }>(
      await fetch(`${BASE}/projects/${id}/synctex/forward?${q}`),
    );
    return data.hits;
  },
  async synctexInverse(id: string, page: number, x: number, y: number): Promise<InverseHit | null> {
    return json(
      await fetch(`${BASE}/projects/${id}/synctex/inverse?page=${page}&x=${x}&y=${y}`),
    );
  },
};
