import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The bundle is deployed into each backend's resources/public and served from the backend's own origin (the
// hosts' static content service), so the app calls its endpoints by absolute path on the same origin and needs
// no CORS. The dev server proxies the same paths to a backend on the agent-question port.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/questions': { target: 'http://127.0.0.1:8092', changeOrigin: true },
      '/transcripts': { target: 'http://127.0.0.1:8092', changeOrigin: true }
    }
  }
});
