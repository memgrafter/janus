# syntax=docker/dockerfile:1
#
# pi-janus: OpenAI-compatible inference proxy + control plane.
#
# Builds the single static binary against the LOCAL (modified) pi-ai, then
# ships it in a minimal non-root image.
#
# Prereq (host) — vendor your built pi-ai into the build context:
#   ./scripts/vendor-pi-ai.sh          # -> vendor/pi-ai/  (from $PI_MONO_AI)
#
# Build:
#   docker build -t <registry>/janus-inference-control-plane:<tag> .
#   # target a specific arch (buildx):
#   docker buildx build --platform linux/amd64 -t <registry>/janus-inference-control-plane:<tag> --load .
#
# The runtime image is inert until you set env (API keys, JANUS_AUTH_JSON,
# JANUS_MODELS_JSON, JANUS_TOKEN) — see chart/ for the k8s wiring.

# ---- build: compile the static binary with the vendored (modified) pi-ai ----
FROM oven/bun:1 AS build
WORKDIR /app

# Install deps for linux. This pulls the registry pi-ai (0.84.2), which the
# next step overlays with the vendored local build.
COPY package.json bun.lock ./
RUN bun install

# Optionally overlay a vendored (locally-modified) pi-ai. If vendor/pi-ai/ is
# present (produced by scripts/vendor-pi-ai.sh), it overrides the bun-installed
# pi-ai; otherwise the build uses whatever `bun install` resolved (e.g. a
# modified pi-ai pinned in package.json/bun.lock). This keeps the image
# compatible with however the pi-ai change is imported into pi-janus.
COPY vendor/ ./vendor/
RUN if [ -d vendor/pi-ai/dist ]; then \
      cp -rf vendor/pi-ai/dist/. node_modules/@earendil-works/pi-ai/dist/ && \
      cp vendor/pi-ai/package.json node_modules/@earendil-works/pi-ai/package.json && \
      echo "overlaid vendored pi-ai $(grep -m1 '"version"' node_modules/@earendil-works/pi-ai/package.json | cut -d'"' -f4)"; \
    else \
      echo "no vendored pi-ai — using bun-installed pi-ai $(grep -m1 '"version"' node_modules/@earendil-works/pi-ai/package.json | cut -d'"' -f4)"; \
    fi

# Compile the static binary. TARGETARCH is set by buildx (amd64/arm64); for a
# plain `docker build` it is empty and we build for the build stage's native arch.
ARG TARGETARCH=""
COPY src ./src
COPY scripts ./scripts
RUN set -euo pipefail; \
    if [ -n "${TARGETARCH}" ]; then \
      case "${TARGETARCH}" in \
        amd64) ./scripts/build.sh --target linux-x64   --out /out --skip-deps ;; \
        arm64) ./scripts/build.sh --target linux-arm64 --out /out --skip-deps ;; \
        *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
      esac; \
    else \
      ./scripts/build.sh --out /out --skip-deps; \
    fi

# ---- runtime: minimal, non-root (glibc for the bun binary) ----
FROM gcr.io/distroless/base-debian12:nonroot
# A container must listen on all interfaces (the binary's default 127.0.0.1 is
# for local-proxy mode). Override with JANUS_HOST if needed.
ENV JANUS_HOST=0.0.0.0
COPY --from=build /out/pi-janus /pi-janus
EXPOSE 8787
USER nonroot
ENTRYPOINT ["/pi-janus"]
