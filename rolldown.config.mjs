/* bundles the maintenance scripts into dist/cli/ for the published `talkative` bin:
   node won't strip types under node_modules, so the .ts sources can't ship as-is.
   src/ imports are inlined; packages stay external and resolve from dependencies. */
import { defineConfig } from 'rolldown';

export default defineConfig({
  input: {
    migrate: 'src/db/migrate.ts',
    admin: 'scripts/admin.ts',
    rekey: 'scripts/rekey.ts',
    'uploads-gc': 'scripts/uploads-gc.ts',
  },
  platform: 'node',
  external: (id) => !id.startsWith('.') && !id.startsWith('/'),
  output: {
    dir: 'dist/cli',
    format: 'esm',
    entryFileNames: '[name].js',
  },
});
