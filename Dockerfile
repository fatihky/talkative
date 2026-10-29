FROM node:24-alpine AS base
# healtchecks need wget
RUN apk add wget
RUN npm install -g pnpm@12.9.1
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# the orm config loads .env if present; init is lazy so nothing connects at build time
RUN BETTER_AUTH_SECRET=dummydata DATABASE_URL=postgresql://build@localhost/build pnpm build

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
# dev deps stay installed: migrations run through drizzle-kit against drizzle
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
# pnpm-workspace.yaml keeps pnpm's settings (allowBuilds, minimumReleaseAgeExclude)
# in effect for the runtime CMD (e.g. `pnpm db:migrate`)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
# open telemetry, preloaded into the server below (config via OTEL_* env vars)
COPY instrumentation.mjs ./
EXPOSE 8080
CMD ["sh", "-c", "pnpm db:migrate && node --import ./instrumentation.mjs dist/serve-node.js"]