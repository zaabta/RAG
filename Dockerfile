FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages

RUN --mount=type=cache,id=sitepilot-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false
COPY src ./src
COPY migrations ./migrations
RUN pnpm run build

FROM base AS production-dependencies

ENV NODE_ENV=production

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages ./packages

RUN --mount=type=cache,id=sitepilot-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter typegraph... \
    && mkdir -p /app/storage/uploads /app/storage/model-cache
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# The final image contains no Corepack/pnpm invocation. Production dependencies,
# including tsx and workspace package builds, are prepared in the prior stage.
COPY --from=production-dependencies --chown=10001:10001 /app /app
RUN mkdir -p /home/sitepilot/.cache \
    && chown -R 10001:10001 /home/sitepilot

USER 10001:10001
ENV HOME=/home/sitepilot
ENV XDG_CACHE_HOME=/home/sitepilot/.cache
ENV FILE_STORAGE_ROOT=/app/storage/uploads
ENV HF_HOME=/app/storage/model-cache
ENV HOST=0.0.0.0
EXPOSE 3210

CMD ["node", "src/sitepilot/docker-entrypoint.mjs"]
