FROM node:24-alpine AS base
RUN npm install -g pnpm@12.9.1
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# the orm config loads .env if present; init is lazy so nothing connects at build time
RUN BETTER_AUTH_SECRET=dummydata DATABASE_URL=postgresql://build@localhost/build pnpm build

# production dependencies only: the build tooling (typescript, rolldown, webpack,
# esbuild, drizzle-kit, ...) never reaches the runtime image. pnpm-workspace.yaml
# keeps pnpm's settings (allowBuilds, minimumReleaseAgeExclude) in effect.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# no pnpm here: migrations and the maintenance commands run from the bundles in
# dist/cli (see rolldown.config.mjs).
FROM node:24-alpine AS runtime
# healthchecks need wget (busybox's can't reach localhost over IPv4)
RUN apk add wget
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
COPY bin ./bin
# open telemetry, preloaded into the server below (config via OTEL_* env vars)
COPY instrumentation.mjs ./
EXPOSE 8080
# maintenance: `docker exec <c> node bin/talkative.mjs admin grant <email>`
CMD ["sh", "-c", "node dist/cli/migrate.js && node --import ./instrumentation.mjs dist/serve-node.js"]
