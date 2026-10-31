import { defineConfig, type Plugin } from 'vite';
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

// Generates dist/sw.js with a precache list of every built file so the app works fully offline.
function serviceWorker(): Plugin {
  return {
    name: 'planmark-sw',
    apply: 'build',
    closeBundle() {
      const dist = join(process.cwd(), 'dist');
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(dist, p).split('\\').join('/'));
        }
      };
      walk(dist);
      const list = files.filter((f) => f !== 'sw.js' && !f.endsWith('.map'));
      const hash = createHash('sha1');
      for (const f of list) hash.update(f).update(readFileSync(join(dist, f)));
      const version = hash.digest('hex').slice(0, 12);
      const tpl = readFileSync(join(process.cwd(), 'src', 'sw.template.js'), 'utf8');
      writeFileSync(join(dist, 'sw.js'), tpl.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(['./', ...list])));
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 4000, sourcemap: false },
  worker: { format: 'es' },
  plugins: [serviceWorker()],
});
