import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

export interface LogEntry {
  timestamp: string;
  component: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  metadata?: any;
}

export interface LogViewerProps {
  sessionId?: string;
  follow?: boolean;
  tail?: number;
  filter?: {
    agent?: string;
    level?: string;
  };
}

const levelColors = {
  info: 'white',
  warn: 'yellow',
  error: 'red',
  debug: 'gray'
};

const componentColors: Record<string, string> = {
  'SUPERVISOR': 'cyan',
  'SESSION': 'blue',
  'AGENT': 'green',
  'WORKER': 'magenta',
  'SERVER': 'yellow'
};

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

function getComponentColor(component: string): string {
  // Check if it's a known component type
  for (const [key, color] of Object.entries(componentColors)) {
    if (component.toUpperCase().includes(key)) {
      return color;
    }
  }
  
  // Default to green for agent names
  if (component.includes('-agent')) {
    return 'green';
  }
  
  return 'white';
}

export function LogViewer({ sessionId, follow = true, tail = 100, filter }: LogViewerProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isFollowing, setIsFollowing] = useState(follow);
  
  useInput((input, key) => {
    if (input === 'f') {
      setIsFollowing(!isFollowing);
    }
    if (key.ctrl && input === 'c') {
      process.exit(0);
    }
  });
  
  useEffect(() => {
    if (!sessionId) return;
    
    // Simulate log streaming - in real implementation, this would connect to the actual log source
    const fetchLogs = async () => {
      try {
        const response = await fetch(`http://localhost:8080/sessions/${sessionId}/logs?tail=${tail}`);
        if (response.ok) {
          const data = await response.json();
          setLogs(data.logs || []);
        }
      } catch (err) {
        // Handle error
      }
    };
    
    fetchLogs();
    
    if (isFollowing) {
      const interval = setInterval(fetchLogs, 1000);
      return () => clearInterval(interval);
    }
  }, [sessionId, isFollowing, tail]);
  
  // Apply filters
  const filteredLogs = logs.filter(log => {
    if (filter?.agent && !log.component.includes(filter.agent)) {
      return false;
    }
    if (filter?.level && log.level !== filter.level) {
      return false;
    }
    return true;
  });
  
  return (
    <Box flexDirection="column">
      {filteredLogs.map((log, i) => (
        <Box key={i}>
          <Text color="gray">[{formatTimestamp(log.timestamp)}] </Text>
          <Text color={getComponentColor(log.component)}>[{log.component}] </Text>
          <Text color={levelColors[log.level]}>{log.message}</Text>
        </Box>
      ))}
      {isFollowing && (
        <Box marginTop={1}>
          <Text color="gray" italic>Following logs... Press 'f' to stop following, Ctrl+C to exit</Text>
        </Box>
      )}
    </Box>
  );
}

// Standalone log streaming component for direct log output
export function LogStream({ url }: { url: string }) {
  const [logs, setLogs] = useState<string[]>([]);
  
  useEffect(() => {
    const eventSource = new EventSource(url);
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLogs(prev => [...prev.slice(-100), data.message]);
    };
    
    return () => eventSource.close();
  }, [url]);
  
  return (
    <Box flexDirection="column">
      {logs.map((log, i) => (
        <Text key={i}>{log}</Text>
      ))}
    </Box>
  );
}