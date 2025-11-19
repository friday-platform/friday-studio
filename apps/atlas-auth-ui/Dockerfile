# Build stage
FROM denoland/deno:alpine-2.5.6 AS builder

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN deno install

# Copy source files
COPY . .

# Build the SvelteKit app
RUN deno task build

# Production stage
FROM nginxinc/nginx-unprivileged:1.29.2-alpine3.22

# Copy built static files from builder
COPY --from=builder /app/build /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/nginx.conf

CMD ["nginx", "-g", "daemon off;"]
