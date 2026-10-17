import { readFileSync } from 'node:fs';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'waku/config';

/* the app version shown in the footer: the bare number is substituted into
   the bundle at build time. reading package.json here (node, build time)
   means no package.json, and none of its other fields, ever reaches dist. */
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

const appVersionPlugin = {
  name: 'app-version',
  config: () => ({
    define: { __APP_VERSION__: JSON.stringify(version) },
  }),
};

const allowedHostsPlugin = {
  name: 'allowed-hosts',
  config: () => ({
    server: {
      allowedHosts: ['fth.ag.fth'],
    },
  }),
};

export default defineConfig({
  vite: {
    plugins: [
      tailwindcss(),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      appVersionPlugin,
      allowedHostsPlugin,
    ],
  },
});
