# syntax=docker/dockerfile:1.28
# check=skip=FromPlatformFlagConstDisallowed
#
# The product's single image (SPEC §12.0–12.1): linux/amd64, Node 24, pinned media tools.
#
#   base        runtime of every role: Node, static FFmpeg/ffprobe with SVT-AV1, system
#               libvips with libheif + libde265 (HEIC is read only, no x265), jemalloc
#   deps        base + compilers: installs the workspace and compiles sharp against the
#               system libvips (sharp's prebuilt binaries cannot read HEIC)
#   media-test  deps + the HEIC encoder used only to generate test fixtures; runs the
#               @contentops/media tests (CI job `media`)
#   app         placeholder: the server and web build stages arrive with apps/server
#
# FFmpeg and SVT-AV1 change only after an A/B on the frozen corpus (SPEC §12.0,
# docs/reference/compression.md). The build below is BtbN's monthly 2026-08-31 build of the
# same FFmpeg commit as the benchmark's 2026-08-30 build (n8.1.2-50-g1a748fe2cd) with the
# same SVT-AV1 (v4.2.0-73-gfb0ed7e59); master-profile output was compared bit for bit.
# Debian trixie ships libvips 8.16.1, so sharp stays at 0.34.2 (the last release that
# accepts it); bump both together.

ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

FROM --platform=linux/amd64 ${NODE_IMAGE} AS ffmpeg
ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz
ARG FFMPEG_SHA256=c733b4b2951e5957e15505f788b2c65a7a41b6da4b289e295852cc38079b4d2b
ADD --checksum=sha256:${FFMPEG_SHA256} ${FFMPEG_URL} /tmp/ffmpeg.tar.xz
RUN apt-get update \
 && apt-get install -y --no-install-recommends xz-utils \
 && mkdir -p /opt/ffmpeg \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=2 \
      --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'

FROM --platform=linux/amd64 ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libvips42t64 libheif1 libheif-plugin-libde265 libde265-0 libjemalloc2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /opt/ffmpeg/ffmpeg /opt/ffmpeg/ffprobe /usr/local/bin/
# System package versions go into recipe digests of photo renditions (packages/media).
RUN mkdir -p /usr/local/share/contentops \
 && dpkg-query -W -f='${Package}=${Version}\n' \
      libvips42t64 libheif1 libheif-plugin-libde265 libde265-0 libwebp7 libjemalloc2 \
      > /usr/local/share/contentops/packages.txt \
 && ffmpeg -hide_banner -version | head -n 1 \
 && npm install -g pnpm@12.0.0 \
 && npm cache clean --force
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 \
    CONTENTOPS_PACKAGES_FILE=/usr/local/share/contentops/packages.txt

FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 pkg-config libvips-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile \
 && node -e "const s=require('./packages/media/node_modules/sharp');if(!s.format.heif.input.file)throw new Error('sharp without HEIF input');console.log('sharp',s.versions)"

FROM deps AS media-test
# heif-enc with x265 only builds HEIC fixtures; the product never encodes HEIC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libheif-examples libheif-plugin-x265 \
 && rm -rf /var/lib/apt/lists/*
COPY . .
ENV CONTENTOPS_MEDIA_TOOLS=1 \
    CONTENTOPS_MEDIA_STRICT=1
CMD ["pnpm", "--filter", "@contentops/media", "test"]

FROM base AS app
WORKDIR /app
# Placeholder: the apps/server and apps/web build stages are added with the server.
