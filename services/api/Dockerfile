FROM golang:1.23-bookworm AS build
WORKDIR /src/services/api

COPY services/api/go.mod services/api/go.sum ./
RUN go mod download
COPY services/api/ ./
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/classg-api ./cmd/classg-api

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
