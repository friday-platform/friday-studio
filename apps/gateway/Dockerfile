FROM golang:1.26.0-alpine3.23 AS build-env

WORKDIR /go/src/atlas

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG GITHUB_SHA=unknown
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-X main.GitCommit=${GITHUB_SHA}" -o /go/bin/gateway ./apps/gateway

FROM alpine:3.23.2

RUN apk --no-cache add ca-certificates

COPY --from=build-env /go/bin/gateway /gateway

USER 65534:65534

ENTRYPOINT ["/gateway"]
