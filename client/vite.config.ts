import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api to the Express backend during development.
export default defineConfig({
  plugins: [react()],
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
