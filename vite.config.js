import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { writeShells } from './tools/og/shells.mjs';

const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:3001';

// Per-section copies of index.html carrying that section's Open Graph card, so
// link previews (which never run JS) show the right title and image. See
// tools/og/shells.mjs; nginx.conf serves them. A throw here fails the build.
function ogSectionShells() {
    let root = '.';
    let outDir = 'dist';
    return {
        name: 'og-section-shells',
        apply: 'build',
        configResolved(config) { root = config.root; outDir = resolve(config.root, config.build.outDir); },
        closeBundle() {
            const written = writeShells({ distDir: outDir, scriptPath: resolve(root, 'script.js') });
            console.log(`og-section-shells: wrote ${written.length} shells`);
        }
    };
}

export default defineConfig({
  plugins: [ogSectionShells()],
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
