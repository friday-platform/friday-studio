FROM traefik:3.6.2

RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl

COPY apps/traefik/extractuserid /plugins-local/src/github.com/tempestteam/traefik/extractuserid

RUN update-ca-certificates
