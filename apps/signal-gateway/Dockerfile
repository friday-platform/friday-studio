# Build stage
FROM golang:1.26rc2-alpine3.23 AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files (from repo root)
COPY go.mod go.sum ./
RUN go mod download

# Copy source code (from repo root)
COPY apps/signal-gateway ./apps/signal-gateway
COPY pkg ./pkg

# Build the application
WORKDIR /build/apps/signal-gateway
ARG GITHUB_SHA=unknown
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-X main.GitCommit=${GITHUB_SHA}" -o signal-gateway .

# Final stage
FROM alpine:3.23.2

RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /build/apps/signal-gateway/signal-gateway .

CMD ["./signal-gateway"]
