#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const { version } = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);

/* the user's directory, not the package's: .env and uploads/ live where
   talkative is run from, so a global install keeps nothing inside node_modules */
const cwd = process.cwd();
try {
  // values already in the environment win
  process.loadEnvFile(join(cwd, '.env'));
} catch {
  // no .env file; env vars come from the environment
}
process.env.UPLOADS_DIR = resolve(
  cwd,
  process.env.UPLOADS_DIR?.trim() || 'uploads',
);

const usage = `talkative v${version}

Usage: talkative [command] [options]

Commands:
  start                      Start the server (default)
  migrate                    Create the database if needed and apply migrations
  admin grant <email|id>     Make a user an admin
  admin revoke <email|id>    Take admin rights away from a user
  keys:rekey [--dry-run | --decrypt]
                             Re-seal stored API keys with the active key version
  uploads:gc [--days N] [--dry-run]
                             Remove orphaned uploads

Options (start):
  -p, --port <port>          Port to listen on (default: 3000, env: PORT)
      --host <host>          Host to bind to (default: 127.0.0.1, env: HOST)
  -h, --help                 Show this help message
  -v, --version              Show the version

A .env file in the current directory is loaded automatically; variables already
set in the environment take precedence. Uploads are stored in ./uploads unless
UPLOADS_DIR says otherwise (relative paths resolve against the current directory).

Examples:
  talkative migrate          Set up the database
  talkative                  Start the server on 127.0.0.1:3000
  talkative -p 8080 --host 0.0.0.0
  talkative admin grant me@example.com`;

const fail = (message) => {
  console.error(`talkative: ${message}`);
  process.exit(1);
};

const run = (script, args, options) => {
  if (!existsSync(script)) {
    fail(
      'production build not found. Run `pnpm build` first or reinstall the package.',
    );
  }
  const child = spawn(process.execPath, [script, ...args], {
    stdio: 'inherit',
    ...options,
  });
  child.on('error', (err) => fail(`failed to start: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(version);
  process.exit(0);
}

const [command = 'start', ...rest] = args[0]?.startsWith('-')
  ? ['start', ...args]
  : args;
const cli = (name) => join(dist, 'cli', `${name}.js`);

switch (command) {
  case 'start': {
    let port = process.env.PORT || '3000';
    let host = process.env.HOST || '127.0.0.1';
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      const value = rest[i + 1];
      if (arg === '-p' || arg === '--port') {
        if (!value) fail(`${arg} needs a value`);
        port = value;
        i++;
      } else if (arg === '--host') {
        if (!value) fail(`${arg} needs a value`);
        host = value;
        i++;
      } else {
        fail(`unknown option: ${arg} (see talkative --help)`);
      }
    }
    if (!/^\d+$/.test(port)) fail(`invalid port: ${port}`);
    /* the built server resolves dist/public against its cwd, so it runs from
       the package root; everything user-relative was resolved above */
    run(join(dist, 'serve-node.js'), [], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'production',
        // open telemetry runs from the user's cwd, where .env and
        // node_modules (@opentelemetry/*, dotenv) live; NODE_OPTIONS stays
        // inherited so a user-set --import/--require survives
        NODE_OPTIONS:
          `--import ${JSON.stringify(join(root, 'instrumentation.mjs'))} ${process.env.NODE_OPTIONS || ''}`.trim(),
        PORT: port,
        HOST: host,
      },
    });
    console.log(`talkative v${version} starting on http://${host}:${port}/`);
    break;
  }
  case 'migrate':
    run(cli('migrate'), rest, {
      env: { ...process.env, MIGRATIONS_DIR: join(root, 'drizzle') },
    });
    break;
  case 'admin':
    run(cli('admin'), rest);
    break;
  case 'keys:rekey':
    run(cli('rekey'), rest);
    break;
  case 'uploads:gc':
    run(cli('uploads-gc'), rest);
    break;
  default:
    fail(`unknown command: ${command} (see talkative --help)`);
}
