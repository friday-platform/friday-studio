import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Table, Column } from '../components/Table.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

export interface SessionCommandProps {
  subcommand?: string;
  args: string[];
  flags: any;
}

export function SessionCommand({ subcommand, args, flags }: SessionCommandProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>('');
  const [data, setData] = useState<any>(null);
  
  useEffect(() => {
    const execute = async () => {
      try {
        switch (subcommand) {
          case 'list':
          case undefined: // Default to list
            await handleList();
            break;
          case 'get':
            await handleGet(args[0]);
            break;
          case 'cancel':
            await handleCancel(args[0]);
            break;
          default:
            setError(`Unknown session command: ${subcommand}. Available: list, get, cancel`);
            setStatus('error');
        }
      } catch (err) {
        setError(err.message);
        setStatus('error');
      }
    };
    
    execute();
  }, []);
  
  async function handleList() {
    const port = flags.port || 8080;
    
    try {
      const response = await fetch(`http://localhost:${port}/sessions`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch sessions: ${response.statusText}`);
      }
      
      const result = await response.json();
      const sessions = result.sessions || [];
      
      // Format sessions for display
      const formattedSessions = sessions.map((session: any) => ({
        id: session.id.substring(0, 12) + '...',
        workspace: session.workspaceName || 'Unknown',
        signal: session.signal || 'manual',
        status: session.status,
        statusBadge: <StatusBadge status={session.status} />,
        started: formatTime(session.startedAt),
        duration: formatDuration(session.startedAt, session.completedAt)
      }));
      
      setData({ type: 'list', sessions: formattedSessions });
      setStatus('ready');
    } catch (err) {
      if (err.message.includes('Connection refused')) {
        setData({ type: 'list', sessions: [] });
        setStatus('ready');
        return;
      }
      throw err;
    }
  }
  
  async function handleGet(sessionId: string | undefined) {
    if (!sessionId) {
      throw new Error('Session ID required. Usage: atlas session get <id>');
    }
    
    const port = flags.port || 8080;
    
    try {
      const response = await fetch(`http://localhost:${port}/sessions/${sessionId}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch session: ${response.statusText}`);
      }
      
      const session = await response.json();
      setData({ type: 'detail', session });
      setStatus('ready');
    } catch (err) {
      throw err;
    }
  }
  
  async function handleCancel(sessionId: string | undefined) {
    if (!sessionId) {
      throw new Error('Session ID required. Usage: atlas session cancel <id>');
    }
    
    const port = flags.port || 8080;
    
    try {
      const response = await fetch(`http://localhost:${port}/sessions/${sessionId}/cancel`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        throw new Error(`Failed to cancel session: ${response.statusText}`);
      }
      
      setData({ type: 'cancelled', sessionId });
      setStatus('ready');
    } catch (err) {
      throw err;
    }
  }
  
  if (status === 'loading') {
    return <Text>Loading...</Text>;
  }
  
  if (status === 'error') {
    return <Text color="red">Error: {error}</Text>;
  }
  
  return <SessionOutput data={data} />;
}

function SessionOutput({ data }: { data: any }) {
  if (!data) return null;
  
  switch (data.type) {
    case 'list':
      if (data.sessions.length === 0) {
        return <Text color="gray">No active sessions</Text>;
      }
      
      const columns: Column[] = [
        { key: 'id', label: 'SESSION ID', width: 20 },
        { key: 'workspace', label: 'WORKSPACE', width: 20 },
        { key: 'signal', label: 'SIGNAL', width: 20 },
        { key: 'statusBadge', label: 'STATUS', width: 12 },
        { key: 'started', label: 'STARTED', width: 12 },
        { key: 'duration', label: 'DURATION', width: 10, align: 'right' }
      ];
      
      return <Table columns={columns} data={data.sessions} />;
      
    case 'detail':
      const session = data.session;
      return (
        <Box flexDirection="column">
          <Text bold color="cyan">Session Details</Text>
          <Text>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
          <Text>ID: <Text color="white">{session.id}</Text></Text>
          <Text>Status: <StatusBadge status={session.status} /></Text>
          <Text>Signal: <Text color="white">{session.signal || 'manual'}</Text></Text>
          <Text>Started: <Text color="white">{new Date(session.startedAt).toLocaleString()}</Text></Text>
          {session.completedAt && (
            <Text>Completed: <Text color="white">{new Date(session.completedAt).toLocaleString()}</Text></Text>
          )}
          <Text>Duration: <Text color="white">{formatDuration(session.startedAt, session.completedAt)}</Text></Text>
          <Text> </Text>
          <Text>Agents Executed:</Text>
          {session.agents?.map((agent: any, i: number) => (
            <Text key={i}>  - {agent.name} <Text color="gray">({agent.status})</Text></Text>
          ))}
        </Box>
      );
      
    case 'cancelled':
      return (
        <Box flexDirection="column">
          <Text color="yellow">✓ Session cancelled</Text>
          <Text>  Session ID: {data.sessionId}</Text>
        </Box>
      );
      
    default:
      return <Text>Unknown output type: {data.type}</Text>;
  }
}

// Helper functions
function formatTime(timestamp: string): string {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

function formatDuration(start: string, end?: string): string {
  if (!start) return 'N/A';
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  const durationMs = endTime - startTime;
  
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}