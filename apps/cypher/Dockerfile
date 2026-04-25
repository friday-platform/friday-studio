# Build stage
FROM golang:1.26.2-alpine3.23 AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files (from repo root)
COPY go.mod go.sum ./
RUN go mod download

# Copy source code (from repo root)
COPY apps/cypher ./apps/cypher
COPY pkg ./pkg

# Build the application
WORKDIR /build/apps/cypher
ARG GITHUB_SHA=unknown
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-X main.GitCommit=${GITHUB_SHA}" -o cypher .

# Final stage
FROM alpine:3.23.4

RUN apk --no-cache add ca-certificates

COPY --from=builder /build/apps/cypher/cypher /cypher

USER 65534:65534

ENTRYPOINT ["/cypher"]
