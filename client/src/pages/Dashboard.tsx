import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ProjectMeta } from '../types';

// Served by the backend so the logo can be swapped at runtime (no rebuild):
// drop a file at <data>/branding/logo.png or set OVERGRASS_LOGO. See server.
const logoUrl = '/api/branding/logo';

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latexmk, setLatexmk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  async function refresh() {
    try {
      setLoading(true);
      setProjects(await api.listProjects());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    api.health().then((h) => setLatexmk(h.latexmk)).catch(() => setLatexmk(null));
  }, []);

  async function handleCreate() {
    const name = prompt('Project name?', 'Untitled Project');
    if (name === null) return;
    setBusy(true);
    try {
      const p = await api.createProject(name || 'Untitled Project');
      navigate(`/project/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const p = await api.importZip(file);
      navigate(`/project/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function handleDelete(p: ProjectMeta) {
    if (!confirm(`Delete project “${p.name}”? This cannot be undone.`)) return;
    try {
      await api.deleteProject(p.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleRename(p: ProjectMeta) {
    const name = prompt('Rename project', p.name);
    if (name === null || name.trim() === '' || name === p.name) return;
    try {
      await api.updateProject(p.id, { name });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleCopy(p: ProjectMeta) {
    setBusy(true);
    try {
      await api.copyProject(p.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddTag(p: ProjectMeta) {
    const input = prompt('Add tag(s) — comma-separated', '');
    if (!input) return;
    const added = input.split(',').map((s) => s.trim()).filter(Boolean);
    if (added.length === 0) return;
    try {
      await api.updateProject(p.id, { tags: [...p.tags, ...added] });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleRemoveTag(p: ProjectMeta, tag: string) {
    try {
      await api.updateProject(p.id, { tags: p.tags.filter((t) => t !== tag) });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function toggleTagFilter(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });
  }

  // All tags across projects (for the filter bar) + the filtered project list.
  const allTags = Array.from(new Set(projects.flatMap((p) => p.tags))).sort((a, b) =>
    a.localeCompare(b),
  );
  const q = query.trim().toLowerCase();
  const filtered = projects.filter((p) => {
    const matchesQuery =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q));
    const matchesTags = activeTags.size === 0 || p.tags.some((t) => activeTags.has(t));
    return matchesQuery && matchesTags;
  });

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="brand">
          <img className="logo-img" src={logoUrl} alt="Overgrass" />
          <div className="brand-text">
            <h1>Overgrass</h1>
            <span className="tagline">your local Overleaf</span>
          </div>
        </div>
        <div className="dash-actions">
          <button className="btn" onClick={handleCreate} disabled={busy}>
            + New project
          </button>
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={busy}>
            ⬆ Import Overleaf .zip
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip"
            hidden
            onChange={handleImport}
          />
        </div>
      </header>

      {latexmk === false && (
        <div className="banner banner-warn">
          <strong>latexmk not detected.</strong> You can edit projects, but compiling needs a TeX
          distribution. Install it with <code>sudo apt-get install texlive-full latexmk</code> and
          restart the server.
        </div>
      )}

      {error && <div className="banner banner-error">{error}</div>}

      {!loading && projects.length > 0 && (
        <div className="dash-toolbar">
          <input
            className="search-input"
            type="search"
            placeholder="Search projects or tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {allTags.length > 0 && (
            <div className="tag-filter">
              <span className="muted small">Tags:</span>
              {allTags.map((t) => (
                <button
                  key={t}
                  className={`tag-chip tag-filter-chip${activeTags.has(t) ? ' active' : ''}`}
                  onClick={() => toggleTagFilter(t)}
                >
                  {t}
                </button>
              ))}
              {activeTags.size > 0 && (
                <button className="tag-clear" onClick={() => setActiveTags(new Set())}>
                  clear
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <main className="project-list">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : projects.length === 0 ? (
          <div className="empty">
            <p>No projects yet.</p>
            <p className="muted">
              Download a project from overleaf.com (Menu → Download → Source) and import the .zip
              here.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <p className="muted">No projects match your search/filter.</p>
          </div>
        ) : (
          <ul className="project-rows">
            {filtered.map((p) => (
              <li key={p.id} className="project-row" onClick={() => navigate(`/project/${p.id}`)}>
                <div className="project-row-main">
                  <span className="project-row-name">{p.name}</span>
                  <span className="muted small project-row-meta">
                    {p.mainFile ?? 'no main file'} · edited {timeAgo(p.updatedAt)}
                  </span>
                  {p.tags.length > 0 && (
                    <div className="project-row-tags" onClick={(e) => e.stopPropagation()}>
                      {p.tags.map((t) => (
                        <span key={t} className="tag-chip">
                          {t}
                          <button
                            className="tag-x"
                            title={`Remove tag “${t}”`}
                            onClick={() => handleRemoveTag(p, t)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="project-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn" title="Add tag" onClick={() => handleAddTag(p)}>
                    🏷 Tag
                  </button>
                  <button className="btn" title="Rename project" onClick={() => handleRename(p)}>
                    ✎ Rename
                  </button>
                  <button className="btn" title="Duplicate project" disabled={busy} onClick={() => handleCopy(p)}>
                    ⧉ Copy
                  </button>
                  <button className="btn btn-danger" title="Delete project" onClick={() => handleDelete(p)}>
                    🗑 Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
