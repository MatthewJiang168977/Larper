# Build context is the repo root: docker build -f apps/api/Dockerfile .
# Multi-arch (amd64 + arm64): the build stage runs on the build machine's platform.
# Its output is plain JS with no native addons, so it runs on either architecture.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @larper/api
COPY apps/api apps/api
RUN pnpm --filter @larper/api build && pnpm deploy --filter @larper/api --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
