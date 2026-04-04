# Friday marketing website
# Build: docker build --build-arg GIT_COMMIT_SHA=$(git rev-parse HEAD) -t friday-website apps/friday-website

# Global build args — available to all stages when re-declared after each FROM.
ARG PUBLIC_ANALYTICS_ENABLED=true

FROM node:25.9.0-alpine3.23 AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .
ARG PUBLIC_ANALYTICS_ENABLED
ARG GIT_COMMIT_SHA
ENV PUBLIC_ANALYTICS_ENABLED=$PUBLIC_ANALYTICS_ENABLED
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
RUN pnpm build

FROM node:25.9.0-alpine3.23 AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

FROM node:25.9.0-alpine3.23
ARG PUBLIC_ANALYTICS_ENABLED
RUN addgroup -g 266 -S friday && adduser -u 266 -S -G friday -h /home/friday friday
COPY --from=builder /app/build /app/build
COPY --from=builder /app/package.json /app/
COPY --from=deps /app/node_modules /app/node_modules
USER friday
WORKDIR /app
ENV PORT=3000 HOST=0.0.0.0 NODE_ENV=production PUBLIC_ANALYTICS_ENABLED=$PUBLIC_ANALYTICS_ENABLED
EXPOSE 3000
CMD ["node", "build"]
