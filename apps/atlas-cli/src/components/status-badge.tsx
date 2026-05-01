// No React import needed with react-jsx
import { Text } from "ink";

interface StatusBadgeProps {
  status: string;
  compact?: boolean;
}

const statusConfig: Record<string, { color: string; symbol?: string; label?: string }> = {
  // Session statuses
  ready: { color: "green", symbol: "●", label: "ready" },
  executing: { color: "yellow", symbol: "◐", label: "executing" },
  completed: { color: "green", symbol: "✓", label: "completed" },
  failed: { color: "red", symbol: "✗", label: "failed" },
  cancelled: { color: "gray", symbol: "◌", label: "cancelled" },

  // Agent statuses
  active: { color: "green", symbol: "●", label: "active" },
  idle: { color: "gray", symbol: "◌", label: "idle" },
  error: { color: "red", symbol: "!", label: "error" },

  // Workspace statuses
  running: { color: "green", symbol: "▶", label: "running" },
  stopped: { color: "gray", symbol: "■", label: "stopped" },
  initializing: { color: "yellow", symbol: "◐", label: "starting" },
};

export function StatusBadge({ status, compact = false }: StatusBadgeProps) {
  const config = statusConfig[status.toLowerCase()] || {
    color: "gray",
    symbol: "?",
    label: status,
  };

  if (compact && config.symbol) {
    return <Text color={config.color}>{config.symbol}</Text>;
  }

  return (
    <Text color={config.color}>
      {config.symbol ? `${config.symbol} ` : ""}
      {config.label || status}
    </Text>
  );
}
