// instrumentation.mjs
// preloaded through NODE_OPTIONS (see package.json `dev`/`start`), so it runs
// before the app's modules are imported and the instrumentations can hook them.

import 'dotenv/config';

import { registerHooks } from 'node:module';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';

registerHooks('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

// OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES=service.name=...,
// which the SDK's env detector picks up; this is the fallback.
const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || 'talkative';

new NodeSDK({
  serviceName,
  instrumentations: [
    // getNodeAutoInstrumentations({
    //   '@opentelemetry/instrumentation-pg': {
    //     enabled: true,
    //     enhancedDatabaseReporting: true,
    //     addSqlCommenterCommentToQueries: true,
    //   },
    // }),
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-openai': {
        enabled: true,
        captureMessageContent: true,
      },
    }),
  ],
}).start();

console.log(`instrumentation started (service: ${serviceName})`);
