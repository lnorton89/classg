FROM node:22-alpine AS build
WORKDIR /src

COPY services/ui/package.json services/ui/package-lock.json ./services/ui/
RUN cd services/ui && npm ci
COPY schemas ./schemas
COPY docs/operator-guide.json ./docs/operator-guide.json
COPY services/ui ./services/ui
ARG CLASSG_TILE_PRELOAD_BBOX=""
ARG CLASSG_TILE_PRELOAD_MIN_ZOOM=12
ARG CLASSG_TILE_PRELOAD_MAX_ZOOM=15
ARG CLASSG_TILE_PRELOAD_MAX_TILES=600
ARG CLASSG_TILE_PRELOAD_CONCURRENCY=8
ARG CLASSG_SATELLITE_TILE_URL=""
RUN cd services/ui && \
    CLASSG_TILE_PRELOAD_BBOX="$CLASSG_TILE_PRELOAD_BBOX" \
    CLASSG_TILE_PRELOAD_MIN_ZOOM="$CLASSG_TILE_PRELOAD_MIN_ZOOM" \
    CLASSG_TILE_PRELOAD_MAX_ZOOM="$CLASSG_TILE_PRELOAD_MAX_ZOOM" \
    CLASSG_TILE_PRELOAD_MAX_TILES="$CLASSG_TILE_PRELOAD_MAX_TILES" \
    CLASSG_TILE_PRELOAD_CONCURRENCY="$CLASSG_TILE_PRELOAD_CONCURRENCY" \
    CLASSG_SATELLITE_TILE_URL="$CLASSG_SATELLITE_TILE_URL" \
    node scripts/preload-satellite-tiles.mjs
RUN cd services/ui && npm run build

FROM nginx:1.27-alpine
COPY services/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/services/ui/dist /usr/share/nginx/html
EXPOSE 80
