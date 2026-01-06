FROM golang:1.25.5-alpine3.23 AS build-env

WORKDIR /go/src/atlas

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG GITHUB_SHA=unknown
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-X main.GitCommit=${GITHUB_SHA}" -o /go/bin/persona ./apps/persona

FROM alpine:3.23.2

RUN apk --no-cache add ca-certificates

COPY --from=build-env /go/bin/persona /persona

USER 65534:65534

ENTRYPOINT ["/persona"]
