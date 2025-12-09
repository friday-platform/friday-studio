# Build stage
FROM golang:1.25.5-alpine3.23 AS builder

# Build arguments
ARG GITHUB_SHA
ARG GITHUB_REF

# Install build dependencies
RUN apk add --no-cache git

# Set working directory
WORKDIR /workspace

# Copy go mod and sum files from monorepo root
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy atlas-operator source code
COPY apps/atlas-operator/cmd/ apps/atlas-operator/cmd/
COPY apps/atlas-operator/internal/ apps/atlas-operator/internal/
COPY apps/atlas-operator/pkg/ apps/atlas-operator/pkg/

# Copy shared packages
COPY pkg/ pkg/

# Build the operator with version information
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -X main.GitCommit=${GITHUB_SHA} -X main.GitRef=${GITHUB_REF}" \
    -a -o atlas-manager ./apps/atlas-operator/cmd/manager

# Runtime stage
FROM alpine:3.23.0

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates

# Note: Alpine already has nobody:nobody user (65534:65534)
# We'll use that instead of creating a new user

# Set working directory
WORKDIR /

# Copy binary from builder
COPY --from=builder /workspace/atlas-manager .

# Use non-root user (nobody:nobody)
USER 65534:65534

# Run the operator
ENTRYPOINT ["/atlas-manager"]
