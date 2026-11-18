import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// PDF.js needs its CMap files (to decode CJK text in fonts that use predefined
// encodings such as H / EUC-H) and its standard-font data (for PDFs that name
// the base-14 fonts without embedding them). Neither is bundled by the import,
// so serve them under /pdfjs/ in dev and copy them into dist/pdfjs/ on build.
const PDFJS_ROOT = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts'];

function pdfjsAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'overgrass-pdfjs-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const [dir] = rel.split('/');
        const file = path.resolve(PDFJS_ROOT, rel);
        if (!PDFJS_ASSET_DIRS.includes(dir) || !file.startsWith(PDFJS_ROOT + path.sep) || !fs.existsSync(file)) {
          return next();
        }
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        fs.cpSync(path.join(PDFJS_ROOT, dir), path.join(outDir, 'pdfjs', dir), { recursive: true });
      }
    },
  };
}

// Proxy /api to the Express backend during development.
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  server: {
    port: 5173,
    // Allow importing assets from the repo root (e.g. ../resources/overgrass-logo.png).
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
