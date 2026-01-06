# Build stage
FROM denoland/deno:alpine-2.6.4 AS builder

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
FROM denoland/deno:alpine-2.6.4

WORKDIR /app

# Copy package.json and install dependencies
COPY package.json ./
RUN deno install

# Copy built app from builder
COPY --from=builder /app/build ./build

# Expose port
EXPOSE 3000

# Start the Node.js server
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys=hostname", "build/index.js"]
