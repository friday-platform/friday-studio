FROM golang:1.26rc2-alpine3.23 AS builder

WORKDIR /build

RUN apk add --no-cache git ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 go build -o atlas-otel-collector ./apps/atlas-otel-collector

FROM alpine:3.23.2

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /build/atlas-otel-collector /otelcol

USER nobody:nobody

ENTRYPOINT ["/otelcol"]
CMD ["--config", "/etc/otel/config.yaml"]
