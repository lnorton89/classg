FROM golang:1.26.6-bookworm AS build
WORKDIR /src/services/fusion

COPY services/fusion/go.mod services/fusion/go.sum ./
RUN go mod download
COPY services/fusion/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/classg-fusion ./cmd/classg-fusion

# Development stage. Placed before the production stage on purpose: a build with
# no --target uses the last stage, so dev at the end would replace the shipped
# image.
FROM golang:1.26.6-bookworm AS dev
WORKDIR /src/services/fusion
RUN go install github.com/air-verse/air@latest
ENV CGO_ENABLED=0
CMD ["air", "-c", ".air.toml"]

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/classg-fusion /classg-fusion
ENTRYPOINT ["/classg-fusion"]
