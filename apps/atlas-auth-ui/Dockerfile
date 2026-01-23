# Build stage
FROM denoland/deno:alpine-2.6.6 AS builder

WORKDIR /app

# Copy package files
COPY apps/atlas-auth-ui/package.json apps/atlas-auth-ui/deno.json ./

# Install dependencies
RUN deno install

# Copy workspace dependency directly into node_modules
COPY packages/ga4/ ./node_modules/@atlas/ga4/

# Copy source files
COPY apps/atlas-auth-ui/ ./

# Build the SvelteKit app
RUN deno task build

# Production stage
FROM denoland/deno:alpine-2.6.6

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
