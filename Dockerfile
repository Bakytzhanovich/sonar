# Image for the Module 8 Level-3 render worker (src/worker.ts).
#
# The API does NOT use this image — it runs on Render's plain Node runtime
# (see render.yaml), because it never touches a video file. This exists for
# one reason: ffmpeg is a system binary, and no Node runtime ships it.
FROM node:20-slim

# ffmpeg pulls in the codecs; ca-certificates is needed for the HTTPS calls to
# object storage and the transcription API. --no-install-recommends keeps the
# image from also pulling X11 and friends via ffmpeg's recommendations.
# fonts-montserrat is what the burned-in captions are styled with, and
# fontconfig is what libass asks for it through. fonts-liberation is the
# fallback for glyphs Montserrat lacks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates fontconfig fonts-montserrat fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Fail the BUILD if the caption font is missing, rather than the render.
# libass does not error on an unresolvable family — it silently substitutes
# whatever it can find, so without this check a deploy would quietly ship
# captions in the wrong typeface and nothing anywhere would say so.
RUN fc-list | grep -qi montserrat \
    || (echo 'Montserrat not installed — captions would silently fall back to another font' && exit 1)

# DeepFilterNet: the speech separator that replaced RNNoise for the render's
# own audio. Fetched as a release binary rather than built — it is Rust, and
# a toolchain in this image would cost more than the 34MB it saves.
#
# The musl build is statically linked, so it runs on this slim Debian base
# without matching its glibc. Pinned: an unpinned "latest" would change what
# the worker sounds like on a rebuild nobody asked for.
#
# Not fatal if it is ever missing at runtime — deepFilter.ts falls back to the
# in-graph denoiser — but a build that silently shipped without it would mean
# every render quietly got worse, so the check below fails the build instead.
ARG DEEP_FILTER_VERSION=0.5.6
ADD https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEP_FILTER_VERSION}/deep-filter-${DEEP_FILTER_VERSION}-x86_64-unknown-linux-musl /usr/local/bin/deep-filter
RUN chmod +x /usr/local/bin/deep-filter && deep-filter --help > /dev/null \
    || (echo 'deep-filter did not run — the render would fall back to the weaker denoiser' && exit 1)

WORKDIR /app

# Dependencies are copied and installed before the source so that a code-only
# change reuses the cached layer instead of reinstalling on every deploy.
COPY package.json package-lock.json ./
# --include=dev for the same reason as render.yaml's build command: tsc lives
# in devDependencies and NODE_ENV=production would otherwise skip it.
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
# The RNNoise model the arnndn denoise filter loads at render time. Resolved
# relative to dist/ at runtime (see RNNOISE_MODEL_PATH), so it has to sit
# beside it, not inside src.
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

# Fail the build rather than ship an image where "убрать фоновый шум" silently
# does nothing — same reasoning as the Montserrat check for subtitles.
RUN test -f assets/rnnoise/bd.rnnn

ENV NODE_ENV=production
CMD ["node", "dist/worker.js"]
