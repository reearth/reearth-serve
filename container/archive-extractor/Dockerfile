FROM golang:1.25-alpine AS builder

# mailcap provides /etc/mime.types; Go's mime package reads it at runtime
# for extensions outside DetectContentType's explicit table (ADR-013 §4).
RUN apk add --no-cache mailcap

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /archive-extractor .

# distroless/static: CA certificates and tzdata maintained upstream, a
# non-root user, /tmp, and a Debian package DB that vulnerability scanners
# understand — none of which scratch has. No shell, no libc.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /etc/mime.types /etc/mime.types
COPY --from=builder /archive-extractor /archive-extractor
EXPOSE 8080
ENTRYPOINT ["/archive-extractor"]
