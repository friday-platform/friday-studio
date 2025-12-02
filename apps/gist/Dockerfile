FROM golang:1.25.4-alpine3.22 AS build-env

WORKDIR /go/src/atlas

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /go/bin/gist ./apps/gist

FROM alpine:3.22.2

RUN apk --no-cache add ca-certificates

COPY --from=build-env /go/bin/gist /gist

USER 65534:65534

ENTRYPOINT ["/gist"]
