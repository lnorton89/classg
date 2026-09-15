FROM golang:1.26.6-bookworm AS build
WORKDIR /src/services/api

COPY services/api/go.mod services/api/go.sum ./
RUN go mod download
COPY services/api/ ./
# The build context excludes .git, so the toolchain cannot stamp a VCS revision
# and About showed "Not stamped" on every deployed unit. Whoever builds the
# image knows the commit -- the deploy agent and `make compose-up` pass it --
# so it is stamped by hand here. Empty when nobody passed one.
ARG CLASSG_BUILD_REVISION=""
ARG CLASSG_BUILD_TIME=""
RUN CGO_ENABLED=1 go build -trimpath \
    -ldflags="-s -w -X github.com/classg/api/internal/system.buildRevision=${CLASSG_BUILD_REVISION} -X github.com/classg/api/internal/system.buildTime=${CLASSG_BUILD_TIME}" \
    -o /out/classg-api ./cmd/classg-api

# Development stage: source is bind-mounted and `air` rebuilds on change, so no
# image rebuild is needed to see a code change.
#
# Deliberately placed BEFORE the production stage. `docker build` with no
# --target builds the LAST stage, so putting dev at the end would silently turn
# every production build into a dev image.
FROM golang:1.26.6-bookworm AS dev
WORKDIR /src/services/api
RUN go install github.com/air-verse/air@latest
# CGO stays on: go-libsql needs it (ADR-0006).
ENV CGO_ENABLED=1
EXPOSE 8081
CMD ["air", "-c", ".air.toml"]

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/classg-api /usr/local/bin/classg-api
RUN useradd --system --uid 10001 --create-home classg \
    && mkdir -p /data /captures \
    && chown -R classg:classg /data /captures
USER classg
EXPOSE 8081
ENTRYPOINT ["classg-api"]
