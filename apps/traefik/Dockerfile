FROM traefik:v3.6.11

RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl

COPY apps/traefik/extractuserid /plugins-local/src/github.com/tempestteam/traefik/extractuserid
COPY apps/traefik/atlaskey /plugins-local/src/github.com/tempestteam/traefik/atlaskey

# GeoBlock plugin and assets
COPY apps/traefik/geoblock /plugins-local/src/github.com/tempestteam/traefik/geoblock
COPY apps/traefik/blocked.html /var/lib/geoip/blocked.html
# Download and validate GeoLite2 database
# - curl -f: fail on HTTP errors (4xx/5xx)
# - Verify file is at least 5MB (valid Country db is ~10MB)
# - Check for MMDB magic marker in metadata section (last 128KB)
RUN curl -fSL -o /var/lib/geoip/GeoLite2-Country.mmdb \
    https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-Country.mmdb \
    && filesize=$(wc -c < /var/lib/geoip/GeoLite2-Country.mmdb) \
    && if [ "$filesize" -lt 5000000 ]; then \
         echo "ERROR: GeoLite2-Country.mmdb too small (${filesize} bytes), expected >5MB"; \
         rm -f /var/lib/geoip/GeoLite2-Country.mmdb; \
         exit 1; \
       fi \
    && if ! tail -c 131072 /var/lib/geoip/GeoLite2-Country.mmdb | strings | grep -q "MaxMind.com"; then \
         echo "ERROR: GeoLite2-Country.mmdb missing MMDB magic marker - file corrupted"; \
         rm -f /var/lib/geoip/GeoLite2-Country.mmdb; \
         exit 1; \
       fi \
    && echo "GeoLite2-Country.mmdb validated (${filesize} bytes)"

RUN update-ca-certificates
