// instrumentation.mjs
// preloaded with `node --import` (see package.json `dev`/`start`, bin/talkative.mjs
// and the Dockerfile), so it runs before the app's modules are imported and the
// instrumentations can hook them.
//
// - exporters, sampler, propagators and resource are configured with the
//   standard OTEL_* variables (https://opentelemetry.io/docs/languages/sdk-configuration/);
//   traces, metrics and logs all default to OTLP. OTEL_SDK_DISABLED=true turns
//   all of it off.
// - the app adds its own GenAI spans, metrics and log events on top
//   (src/server/telemetry.ts): one `invoke_agent` span per reply, `chat <model>`
//   per completion round-trip and `execute_tool <name>` per tool call.
// - console.log/info/warn/error/debug are mirrored into OTel log records,
//   correlated with the active span, so the app's existing logs reach the
//   collector too. OTEL_LOGS_EXPORTER=none leaves the console alone.
// - incoming http spans are named `<METHOD> <route>` with ids collapsed to
//   `:id`, so `/api/chats/<uuid>/messages` groups as one operation.
// - SIGTERM/SIGINT flush pending spans/metrics/logs before the process exits.

import 'dotenv/config';

import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { format } from 'node:util';
import { context, logs, SeverityNumber } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  register as registerSyncHooks,
  supportsSyncHooks,
} from 'import-in-the-middle/register-hooks.mjs';

// ESM loader hook so instrumentations also patch modules loaded with `import`.
// node >= 22.22.3 / 24.11.1 / 25.1 / 26 run it in-thread through
// module.registerHooks; older ones fall back to the (deprecated on 26)
// off-thread module.register loader.
if (supportsSyncHooks()) registerSyncHooks();
else nodeModule.register('import-in-the-middle/hook.mjs', import.meta.url);

const env = (k) => process.env[k]?.trim() ?? '';
const disabled = env('OTEL_SDK_DISABLED').toLowerCase() === 'true';

const readVersion = () => {
  try {
    return JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
    ).version;
  } catch {
    return undefined;
  }
};

// OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES=service.name=...,
// which the SDK's env detector picks up; this is the fallback.
const serviceName = env('OTEL_SERVICE_NAME') || 'talkative';
const serviceVersion = readVersion();

/* ---------- http ---------- */

// requests not worth a trace: built assets, static files, and the compose
// healthcheck polling `/` with wget every 10 s
const STATIC =
  /^\/(assets|images)\/|\.(js|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|txt|webmanifest)$/;
const pathOf = (req) => (req.url ?? '/').split('?')[0] || '/';
const ignoreIncoming = (req) => {
  const path = pathOf(req);
  if (STATIC.test(path)) return true;
  const ua = req.headers?.['user-agent'] ?? '';
  return path === '/' && ua.startsWith('Wget');
};

// ids in a path → `:id`, so span names and the http.route metric dimension
// stay low-cardinality: uuids, numbers, and long tokens mixing letters and
// digits (nanoid-style ids)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (s) =>
  UUID.test(s) ||
  /^\d+$/.test(s) ||
  (s.length >= 16 && /\d/.test(s) && /[a-z]/i.test(s));
const routeOf = (path) =>
  path
    .split('/')
    .map((seg) => (seg && isId(seg) ? ':id' : seg))
    .join('/');

// the http instrumentation reads the route back from the rpc metadata when the
// response finishes: it renames the span `<METHOD> <route>`, sets http.route
// and adds it to http.server.request.duration
const nameIncoming = (span, req) => {
  if (!req.headers) return; // outgoing request
  const route = routeOf(pathOf(req));
  const rpc = getRPCMetadata(context.active());
  if (rpc?.type === RPCType.HTTP) rpc.route = route;
  span.updateName(`${req.method ?? 'GET'} ${route}`);
};

/* ---------- console → logs ---------- */

const SEVERITY = {
  debug: [SeverityNumber.DEBUG, 'DEBUG'],
  log: [SeverityNumber.INFO, 'INFO'],
  info: [SeverityNumber.INFO, 'INFO'],
  warn: [SeverityNumber.WARN, 'WARN'],
  error: [SeverityNumber.ERROR, 'ERROR'],
};

// the unpatched methods, for src/server/telemetry.ts: it prints its structured
// records itself and must not be mirrored a second time
const RAW = Symbol.for('talkative.otel.rawConsole');

const bridgeConsole = () => {
  const logger = logs.getLogger('talkative.console', serviceVersion);
  const raw = {};
  let inside = false;
  for (const [method, [severityNumber, severityText]] of Object.entries(
    SEVERITY,
  )) {
    const original = console[method].bind(console);
    raw[method] = original;
    console[method] = (...args) => {
      original(...args);
      // a log written while exporting a log must not loop back in
      if (inside) return;
      inside = true;
      try {
        const body = format(...args);
        // the app prefixes lines with their module: "[runs] flush failed: …"
        const component = /^\[([\w.-]+)\]/.exec(body)?.[1];
        const err = args.find((a) => a instanceof Error);
        logger.emit({
          severityNumber,
          severityText,
          body,
          context: context.active(),
          attributes: {
            'log.source': 'console',
            ...(component ? { 'talkative.component': component } : {}),
            ...(err
              ? {
                  'exception.type': err.name,
                  'exception.message': err.message,
                  ...(err.stack ? { 'exception.stacktrace': err.stack } : {}),
                }
              : {}),
          },
        });
      } catch {
        // telemetry must never break logging
      } finally {
        inside = false;
      }
    };
  }
  globalThis[RAW] = raw;
};

/* ---------- sdk ---------- */

if (!disabled) {
  if (serviceVersion) {
    // NodeSDK only takes a name directly; the version rides on the env
    // resource detector unless the user already set one
    const attrs = env('OTEL_RESOURCE_ATTRIBUTES');
    if (!/(^|,)\s*service\.version=/.test(attrs))
      process.env.OTEL_RESOURCE_ATTRIBUTES = [
        attrs,
        `service.version=${serviceVersion}`,
      ]
        .filter(Boolean)
        .join(',');
  }
  const sdk = new NodeSDK({
    serviceName,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: ignoreIncoming,
          requestHook: nameIncoming,
        },
        // one span per query; statement text only (no bound parameters: they
        // carry message bodies and sealed provider keys). queries outside a
        // traced operation (pool housekeeping, the catalog sweeper) are dropped
        '@opentelemetry/instrumentation-pg': {
          enhancedDatabaseReporting: false,
          requireParentSpan: true,
        },
        '@opentelemetry/instrumentation-ioredis': { requireParentSpan: true },
        // provider calls go through fetch (undici); the app's own GenAI spans
        // wrap them, so the openai SDK instrumentation has nothing to hook
        '@opentelemetry/instrumentation-openai': { enabled: false },
        // the app logs through console (bridged above), not pino
        '@opentelemetry/instrumentation-pino': { enabled: false },
        // high-volume, low-signal for this app
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();

  const logsOff = env('OTEL_LOGS_EXPORTER')
    .split(',')
    .some((e) => e.trim() === 'none');
  if (!logsOff) bridgeConsole();

  // flush what's buffered before the process goes away; NodeSDK installs no
  // signal handlers itself, and adding one replaces node's default exit.
  // beforeExit covers a process that simply runs out of work: the export
  // keeps the loop alive until it's done
  let stopping = false;
  process.once('beforeExit', () => {
    if (stopping) return;
    stopping = true;
    sdk.shutdown().catch(() => {});
  });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      if (stopping) return;
      stopping = true;
      const timeout = setTimeout(() => process.exit(0), 5000);
      timeout.unref();
      sdk
        .shutdown()
        .catch((e) =>
          (globalThis[RAW]?.warn ?? console.warn)(
            `[otel] shutdown failed: ${e?.message ?? e}`,
          ),
        )
        .finally(() => process.exit(0));
    });
  }

  console.log(
    `[otel] instrumentation started (service: ${serviceName}${serviceVersion ? `@${serviceVersion}` : ''})`,
  );
}
