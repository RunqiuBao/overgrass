<p align="center">
  <img src="resources/overgrass-logo.png" alt="Overgrass logo" width="160" height="160" />
</p>

<h1 align="center">Overgrass — your local Overleaf</h1>

A self-hosted, local clone of [Overleaf](https://www.overleaf.com): import the
projects you download from Overleaf and edit them on your own machine, with a
LaTeX source editor and live PDF preview side by side.

Built with **React + TypeScript** (Vite) on the front end and a small
**TypeScript / Express** backend that compiles LaTeX with your local TeX
distribution via `latexmk`.

![layout](https://img.shields.io/badge/layout-files%20%E2%80%A2%20editor%20%E2%80%A2%20pdf-138a36)

## Features

- **Import Overleaf `.zip`** — Overleaf → *Menu → Download → Source*, then drop the
  zip into the dashboard. Nested top-level folders are flattened automatically.
- **Overleaf-style 3-pane workspace** — file tree • CodeMirror 6 editor (LaTeX
  syntax highlighting, search, fold, line wrap) • PDF.js preview.
- **Real LaTeX compilation** via `latexmk` (handles multi-pass refs, bibtex/biber).
- **Live PDF preview** with zoom and multi-page rendering.
- **Auto-save** (debounced); **`Ctrl/Cmd+S`** recompiles (saving first), just like
  Overleaf — or use the **Recompile** button.
- **Full project file management** — create / rename / delete files & folders,
  upload images and other assets, set the main `.tex` file.
- **SyncTeX two-way sync** (just like Overleaf's click-to-jump):
  - **Source → PDF**: double-click a line in the editor; the PDF scrolls to and
    flashes the matching spot.
  - **PDF → source**: double-click anywhere in the PDF; the matching source file
    opens and the editor jumps to that line.
- **Claude AI assistant** — select text in the editor and **Ctrl/Cmd + right-click**
  to open a floating assistant: your selection is pre-loaded, you add an
  instruction (rewrite, fix, translate, explain…), and you choose whether to
  **replace the selection** with Claude's suggestion. Click outside to dismiss.
- **Version history & rollback** — every compile checkpoints your source (and you
  can **Save version** with a label anytime). Open **🕘 History** to browse versions
  and **Restore** any of them. Rollback is non-destructive (your current state is
  snapshotted first), backed by a hidden per-project Git repo.
- **Compilation log panel** that pops open on errors.
- **Export** the project back to a `.zip` at any time.

## Quick start with Docker (recommended)

The Docker image bundles **Node + a full TeX distribution**, so you don't need
to install anything on your host except Docker — LaTeX compiles inside the
container.

```bash
# build the image and start the container
DATA_DIR=~/overgrass-projects npm run docker:up
#   or directly:
DATA_DIR=~/overgrass-projects scripts/docker.sh up
```

On its first run, the script installs an `overgrass` shell function into
`~/.bashrc`, so afterwards you can manage the container **from any directory**:

```bash
source ~/.bashrc                       # once (new terminals get it automatically)
DATA_DIR=~/overgrass-projects overgrass up
overgrass logs
overgrass restart
overgrass down
```

(Set `OVERGRASS_NO_ALIAS=1` to skip the `~/.bashrc` install.)

Then open <http://localhost:3001>. By default, projects persist in a Docker
**named volume** (`overgrass-data`, stored under
`/var/lib/docker/volumes/overgrass-data/_data`; run
`docker volume inspect overgrass-data` to see the exact path).

**To store projects in a folder you choose** on your disk instead, set
`DATA_DIR` (a bind mount):

```bash
DATA_DIR=~/overgrass-projects scripts/docker.sh up
```

Your `.tex` sources then live directly in `~/overgrass-projects/projects/<id>/`,
easy to back up or open with other tools.

```bash
scripts/docker.sh logs      # follow logs
scripts/docker.sh down      # stop & remove the container
scripts/docker.sh restart   # rebuild + restart
```

Or with Docker Compose:

```bash
docker compose up -d --build
```

> **First build is slow & large.** `texlive-full` downloads several GB. For a
> much smaller image, override the TeX package set:
>
> ```bash
> TEX_PACKAGES="texlive-latex-extra texlive-bibtex-extra texlive-fonts-recommended biber latexmk" \
>   scripts/docker.sh up
> ```
>
> (or set the same `TEX_PACKAGES` build arg in `docker-compose.yml`).

Configuration env vars for the script: `PORT` (host port, default 3001),
`IMAGE`, `CONTAINER`, `DATA_VOLUME`, `TEX_PACKAGES`.

### Claude AI assistant

Two billing options — the assistant prefers your subscription when a token is
present, and falls back to an API key otherwise. Credentials are stored
**server-side** in `<data>/claude-config.json` (never in the browser).

**Option 1 — Claude Pro/Max subscription (no per-token cost).** Driven by the
bundled Claude Code CLI. On a machine with a browser, generate a long-lived
token:

```bash
claude setup-token        # one-time browser OAuth; prints an sk-ant-oat… token
```

Paste that token into the assistant's first-use prompt, or supply it via env:

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...  overgrass up
```

**Option 2 — Anthropic API key (pay-per-token).** Paste an `sk-ant-api…` key, or:

```bash
ANTHROPIC_API_KEY=sk-ant-api...  overgrass up
```

The credential type is auto-detected by prefix. Override the model with
`OVERGRASS_CLAUDE_MODEL` (CLI aliases like `sonnet`/`opus` for the subscription
path; a full id like `claude-opus-4-8` for the API path). Env vars take
precedence over saved credentials.

Usage: select text in the editor → **Ctrl/Cmd + right-click** → type an
instruction → **Ask Claude** → **Replace selection** or **Keep original**.

> **Subscription terms:** use this with **your own** Pro/Max subscription on your
> **own** instance. Anthropic does not permit offering claude.ai/subscription
> login to other users of a third-party app — don't expose this as a multi-user
> "bring your own Claude login" service. The selected snippet plus your
> instruction are sent to Anthropic when you click Ask.

## Local development (without Docker)

```bash
# from the repo root
npm install        # installs both workspaces (client + server)
npm run dev        # starts the API (:3001) and the Vite dev server (:5173)
```

Open <http://localhost:5173>. This needs a host TeX install for compilation —
see [Prerequisites](#prerequisites).

### Production build (single port, no Docker)

```bash
npm run build      # builds server -> server/dist and client -> client/dist
npm start          # Express serves the API *and* the built client on :3001
```

When `client/dist` exists, the server serves it on the same origin (single
port). Override its location with the `CLIENT_DIST` env var.

## How it works

```
client (React + Vite, :5173)
  └─ /api/* ──proxy──▶ server (Express, :3001)
                         ├─ projects stored on disk under  ./data/projects/<id>/
                         ├─ metadata in  .overgrass.json
                         ├─ build output in  .build/  (hidden from the file tree)
                         └─ compile: latexmk -pdf -interaction=nonstopmode <main>.tex
```

- **Projects** live as plain folders under `data/projects/`, so your `.tex`
  sources stay on your filesystem and are easy to back up or open in another tool.
- The **main file** is auto-detected (`main.tex`, else the first file containing
  `\documentclass`) and can be overridden with the ★ button in the file tree.
- Set a custom data directory with the `OVERGRASS_DATA` env var.

## Project layout

```
overgrass/
├── package.json          # npm workspaces + dev/build/docker scripts
├── Dockerfile            # multi-stage: build app, then Node + TeX Live runtime
├── docker-compose.yml    # one-command run with a persistent data volume
├── scripts/docker.sh     # build/up/down/logs helper
├── scripts/check-tex.mjs # TeX toolchain check
├── server/               # Express + TypeScript API
│   └── src/
│       ├── index.ts      # routes
│       ├── store.ts      # on-disk project storage, zip import/export
│       └── compile.ts    # latexmk compilation
└── client/               # React + TypeScript (Vite)
    └── src/
        ├── pages/        # Dashboard, Workspace
        ├── components/   # FileTree, CodeEditor, PdfViewer
        └── api.ts        # typed API client
```

## Notes & limitations

- Compilation runs your local `latexmk`; first compile of a document may pull in
  packages depending on your TeX install.
- No multi-user / real-time collaboration — this is a single-user local tool.
- SyncTeX needs the `synctex` binary (bundled with TeX Live) and a successful
  compile first; precision depends on your TeX version's SyncTeX data.

## License

Copyright (C) 2026 Runqiu Bao

Overgrass is free software: you can redistribute it and/or modify it under the
terms of the **GNU General Public License v3.0 or later** as published by the
Free Software Foundation. See [LICENSE](LICENSE) for the full text.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.
