# Air-gapped Document OCR Extractor.
#
# Produces a ~1.8 GB image that serves the app with every model weight baked
# in, so the running container needs no network access at all. OCR and all
# document data stay in the operator's browser; this image is purely a static
# file server.
#
# BUILD THIS ON A NETWORKED MACHINE (it downloads ~1.64 GB of model weights),
# then transfer the image to the air-gapped host - see the README.
#
#   docker build -t document-ocr-extractor:latest .
#   docker save document-ocr-extractor:latest | gzip > doe.tar.gz
#   # ...copy doe.tar.gz across...
#   docker load < doe.tar.gz
#   docker run --rm -p 8080:80 document-ocr-extractor:latest
#   # then open http://localhost:8080
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

# VITE_OFFLINE_MODELS: resolve every model weight same-origin from
#   public/models/ (vendored above) instead of the HuggingFace CDN.
# VITE_OCR_ONLY: no LLM extraction stage - OCR, review and export only, and
#   the setup wizard (which exists only to configure an LLM) is skipped.
# `npm run build` runs prepare-build first, staging the ONNX Runtime WASM, the
# patched layout graph, the wllama runtime and the bundled schemas.
ENV VITE_OFFLINE_MODELS=true \
    VITE_OCR_ONLY=true
RUN npm run build

# ----------------------------------------------------------------- run stage
FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

# Fail the healthcheck if the shell stops being served.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -qO /dev/null http://localhost/ || exit 1
