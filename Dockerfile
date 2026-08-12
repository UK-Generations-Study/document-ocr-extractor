# Air-gapped Document OCR Extractor.
#
# Produces a ~1.8 GB image that serves the app with every model weight baked
# in, so the running container needs no network access at all. OCR and all
# document data stay in the operator's browser; this image is a static file
# server plus a reverse proxy to the Presidio analyzer container.
#
# BUILD THIS ON A NETWORKED MACHINE (it downloads ~1.64 GB of model weights),
# then transfer the image to the air-gapped host - see the README.
#
# This image is half of the deployment: de-identification lives in a second
# image built from docker/presidio/, and compose.yaml in the repo root runs
# the pair. scripts/build-airgap.ps1 builds both and saves them as one
# tarball, which is the intended way in:
#
#   scripts/build-airgap.ps1
#   # ...copy doe-docker-image.tar and compose.yaml across...
#   docker load -i doe-docker-image.tar
#   docker compose up -d
#   # then open http://localhost:7777
#
# To build just this image by hand:
#
#   docker build -t document-ocr-extractor:latest .
#
# Build args let you trade image size against capability:
#   FETCH_DEEP=--deep   vendor the Deep Read VLM too (default; +1.37 GB)
#   FETCH_DEEP=         Quick Read only (~270 MB of models)

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS builder

# Include the Deep Read (GLM-OCR) weights by default.
ARG FETCH_DEEP=--deep

WORKDIR /app

# Dependencies first so this layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci

# Model weights next: a slow, rarely-invalidated layer. Only the fetch script
# is copied in, so editing app source doesn't force a 1.64 GB re-download.
COPY scripts/fetch-models.mjs ./scripts/
RUN node scripts/fetch-models.mjs ${FETCH_DEEP}

# Now the application source.
COPY . .

# VITE_OFFLINE_MODELS: resolve every OCR model weight same-origin from
#   public/models/ (vendored above) instead of the HuggingFace CDN. This says
#   nothing about the LLM: no LLM weights are bundled, and the in-browser
#   (WebLLM) option still fetches its model on first use, so it needs a host
#   with internet. Endpoint-based providers need only a reachable base URL.
#
# No default pipeline mode is baked in: this image runs on reading machines,
# extracting machines and machines doing both, so it asks on first launch
# rather than guessing (src/core/mode.js).
#
# `npm run build` runs prepare-build first, staging the ONNX Runtime WASM, the
# patched layout graph, the wllama runtime and the bundled schemas.
ENV VITE_OFFLINE_MODELS=true
RUN npm run build

# ----------------------------------------------------------------- run stage
FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

# Fail the healthcheck if the shell stops being served.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -qO /dev/null http://localhost/ || exit 1
