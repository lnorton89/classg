FROM golang:1.23-bookworm AS build
WORKDIR /src/services/fusion

COPY services/fusion/go.mod services/fusion/go.sum ./
RUN go mod download
COPY services/fusion/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/classg-fusion ./cmd/classg-fusion

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/classg-fusion /classg-fusion
ENTRYPOINT ["/classg-fusion"]
