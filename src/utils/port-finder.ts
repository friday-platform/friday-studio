/**
 * Port finder utility for dynamic port allocation
 */

const DEFAULT_PORT_RANGE = { start: 8080, end: 8180 };

interface PortFinderOptions {
  preferredPort?: number;
  startPort?: number;
  endPort?: number;
  host?: string;
}

/**
 * Check if a port is available by attempting to create a listener
 */
function isPortAvailable(port: number, host: string = "localhost"): boolean {
  try {
    const listener = Deno.listen({ port, hostname: host });
    listener.close();
    return true;
  } catch {
    // Port is in use or permission denied
    return false;
  }
}

/**
 * Find an available port within a range
 */
export function findAvailablePort(options: PortFinderOptions = {}): number {
  const {
    preferredPort,
    startPort = DEFAULT_PORT_RANGE.start,
    endPort = DEFAULT_PORT_RANGE.end,
    host = "localhost",
  } = options;

  // Try preferred port first
  let triedPreferred = false;
  if (preferredPort && preferredPort >= startPort && preferredPort <= endPort) {
    if (isPortAvailable(preferredPort, host)) {
      return preferredPort;
    }
    triedPreferred = true;
  }

  // Try sequential ports in range
  for (let port = startPort; port <= endPort; port++) {
    // Skip preferred port if we already tried it
    if (triedPreferred && port === preferredPort) {
      continue;
    }
    if (isPortAvailable(port, host)) {
      return port;
    }
  }

  // If no port in range is available, try random ports
  for (let i = 0; i < 100; i++) {
    const randomPort = Math.floor(Math.random() * (65535 - 1024) + 1024);
    if (isPortAvailable(randomPort, host)) {
      return randomPort;
    }
  }

  throw new Error(
    `No available ports found. Tried range ${startPort}-${endPort} and random ports.`,
  );
}

/**
 * Get the next available port starting from a given port
 */
export function getNextAvailablePort(startPort: number, host: string = "localhost"): number {
  return findAvailablePort({ startPort: startPort + 1, endPort: 65535, host });
}
