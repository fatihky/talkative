import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'waku/config';

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
      allowedHostsPlugin,
    ],
  },
});
