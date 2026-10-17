/*
 * global.d.ts — ambient module declarations for non-TS imports and globals.
 *
 * Business logic:
 * - Tells TypeScript that `import '…*.css'` (e.g. styles.css in
 *   pages/_layout.tsx) is a valid side-effect module: Vite bundles the
 *   stylesheet and there are no typed exports to check.
 * - __APP_VERSION__ is the package.json version string, inlined by the
 *   `app-version` vite plugin in waku.config.ts at build time.
 */
declare module '*.css';

declare const __APP_VERSION__: string;
