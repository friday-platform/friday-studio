# Friday marketing website
# Build: docker build -t friday-website apps/friday-website
FROM node:24.13.1-alpine3.23 AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
ARG PUBLIC_ANALYTICS_ENABLED=true
ENV PUBLIC_ANALYTICS_ENABLED=$PUBLIC_ANALYTICS_ENABLED
RUN pnpm build

FROM node:24.13.1-alpine3.23 AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

FROM node:24.13.1-alpine3.23
RUN addgroup -g 266 -S friday && adduser -u 266 -S -G friday -h /home/friday friday
COPY --from=builder /app/build /app/build
COPY --from=builder /app/package.json /app/
COPY --from=deps /app/node_modules /app/node_modules
USER friday
WORKDIR /app
ENV PORT=3000 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 3000
CMD ["node", "build"]
