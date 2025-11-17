# Build stage
FROM golang:1.25.4-alpine3.22 AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files (from repo root)
COPY go.mod go.sum ./
RUN go mod download

# Copy source code (from repo root)
COPY apps/bounce ./apps/bounce
COPY pkg ./pkg

# Build the application
WORKDIR /build/apps/bounce
RUN CGO_ENABLED=0 GOOS=linux go build -o bounce .

# Final stage
FROM alpine:3.22.2

RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /build/apps/bounce/bounce .

CMD ["./bounce"]
