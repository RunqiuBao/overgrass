# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1 — build: install all deps and compile the client + server bundles.
# =============================================================================
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm install

# Build both workspaces -> server/dist and client/dist.
COPY . .
RUN npm run build

# =============================================================================
# Stage 2 — runtime: Node + a TeX distribution to actually compile LaTeX.
# =============================================================================
FROM node:20-bookworm-slim AS runtime

# TeX packages to install. Defaults to the full distribution (large, ~4-5 GB)
# to maximize compatibility with arbitrary Overleaf projects. Override with a
# slimmer set, e.g.:
#   docker build --build-arg TEX_PACKAGES="texlive-latex-extra texlive-bibtex-extra texlive-fonts-recommended biber latexmk" .
ARG TEX_PACKAGES="texlive-full latexmk"
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends ${TEX_PACKAGES} \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Install only the server's production dependencies (standalone, no workspaces).
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev

# Copy the compiled server and the static client build.
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist
# Bundled default logo (fallback when no runtime logo is provided).
COPY --from=builder /app/resources ./resources

# Runtime configuration (see server/src/store.ts and index.ts).
ENV PORT=3001
ENV CLIENT_DIST=/app/client/dist
ENV OVERGRASS_DATA=/data

# Projects persist here — mount a volume to keep them across container restarts.
VOLUME ["/data"]
EXPOSE 3001

# Quick liveness check against the health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
