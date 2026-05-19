# libvips needs runtime + headers, and govips needs cgo, so we cannot use a
# scratch base. Use Debian slim to share the same libvips between build and
# runtime stages.
FROM golang:1.25-bookworm AS builder

# libvips development headers for cgo build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o /thumbnail .

FROM debian:bookworm-slim

# libvips42 is the runtime shared library; ca-certificates needed for HTTPS to R2.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips42 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /thumbnail /thumbnail
EXPOSE 8080
ENTRYPOINT ["/thumbnail"]
