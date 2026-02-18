# Build stage
FROM denoland/deno:alpine-2.6.10 AS builder

WORKDIR /app

# Copy package files
COPY apps/atlas-auth-ui/package.json apps/atlas-auth-ui/deno.json ./

# Install dependencies
RUN deno install

# Copy workspace dependencies directly into node_modules
COPY packages/analytics/ ./node_modules/@atlas/analytics/
COPY packages/logger/ ./node_modules/@atlas/logger/

# Copy source files
COPY apps/atlas-auth-ui/ ./

# Build the SvelteKit app
RUN deno task build

# Production stage
FROM denoland/deno:alpine-2.6.10

WORKDIR /app

# Copy app package files and install production dependencies
COPY apps/atlas-auth-ui/package.json apps/atlas-auth-ui/deno.json ./
RUN deno install

# Copy built app from builder
COPY --from=builder /app/build ./build

# Expose port
EXPOSE 3000

# Start the Node.js server
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys=hostname", "build/index.js"]
