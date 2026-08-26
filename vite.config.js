import { defineConfig } from 'vite';

const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:3001';

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      // Dev parity with production nginx: the backend serves sitemap.xml and
      // robots.txt so previewing SEO output locally hits the same code path.
      '/sitemap.xml': { target: apiTarget, changeOrigin: true },
      '/robots.txt': { target: apiTarget, changeOrigin: true },
      // Audit F-060: production nginx has `location = /developers` proxying to
      // the backend's server-rendered copy, but dev did not — so a hard load
      // of /developers in `npm run dev` silently hit the SPA version instead.
      // The two are genuinely different documents, which is exactly how they
      // drifted apart without anyone noticing.
      '/developers': { target: apiTarget, changeOrigin: true }
    }
  },
  build: {
    target: 'esnext'
  }
});
