import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { exists } from "https://deno.land/std@0.208.0/fs/exists.ts";
import * as yaml from "https://deno.land/std@0.208.0/yaml/mod.ts";
import { Table, Column } from '../components/Table.tsx';

export interface SignalCommandProps {
  subcommand?: string;
  args: string[];
  flags: any;
}

export function SignalCommand({ subcommand, args, flags }: SignalCommandProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>('');
  const [data, setData] = useState<any>(null);
  
  useEffect(() => {
    const execute = async () => {
      try {
        switch (subcommand) {
          case 'list':
            await handleList();
            break;
          case 'trigger':
            await handleTrigger(args[0], flags);
            break;
          case 'history':
            await handleHistory();
            break;
          default:
            setError(`Unknown signal command: ${subcommand}. Available: list, trigger, history`);
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
    if (!await exists('workspace.yml')) {
      throw new Error('No workspace.yml found. Run "atlas workspace init" first.');
    }
    
    const config = yaml.parse(await Deno.readTextFile('workspace.yml')) as any;
    const signals = Object.entries(config.signals || {}).map(([id, signal]: [string, any]) => ({
      id,
      provider: signal.provider || 'cli',
      agents: signal.mappings?.[0]?.agents?.join(', ') || '',
      strategy: signal.mappings?.[0]?.strategy || 'sequential',
      description: signal.description || ''
    }));
    
    setData({ type: 'list', signals });
    setStatus('ready');
  }
  
  async function handleTrigger(signalName: string | undefined, flags: any) {
    if (!signalName) {
      throw new Error('Signal name required. Usage: atlas signal trigger <name> --data \'{"key": "value"}\'');
    }
    
    const data = flags.data || flags.d;
    if (!data) {
      throw new Error('Data required. Usage: atlas signal trigger <name> --data \'{"key": "value"}\'');
    }
    
    let payload;
    try {
      payload = JSON.parse(data);
    } catch (err) {
      throw new Error(`Invalid JSON data: ${err.message}`);
    }
    
    const port = flags.port || flags.p || 8080;
    
    try {
      const response = await fetch(`http://localhost:${port}/signals/${signalName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to trigger signal: ${response.status} ${response.statusText}. ${errorText}`);
      }
      
      const result = await response.json();
      setData({ 
        type: 'triggered', 
        signal: signalName,
        sessionId: result.sessionId,
        status: result.status 
      });
      setStatus('ready');
    } catch (err) {
      if (err.message.includes('Connection refused')) {
        throw new Error(`Cannot connect to workspace server on port ${port}. Is it running? Use 'atlas workspace serve' to start it.`);
      }
      throw err;
    }
  }
  
  async function handleHistory() {
    // TODO: Implement signal history
    setData({ type: 'history', history: [] });
    setStatus('ready');
  }
  
  if (status === 'loading') {
    return <Text>Loading...</Text>;
  }
  
  if (status === 'error') {
    return <Text color="red">Error: {error}</Text>;
  }
  
  return <SignalOutput data={data} />;
}

function SignalOutput({ data }: { data: any }) {
  if (!data) return null;
  
  switch (data.type) {
    case 'list':
      if (data.signals.length === 0) {
        return <Text color="gray">No signals configured</Text>;
      }
      
      const columns: Column[] = [
        { key: 'id', label: 'SIGNAL', width: 20 },
        { key: 'provider', label: 'PROVIDER', width: 10 },
        { key: 'agents', label: 'AGENTS', width: 40 },
        { key: 'strategy', label: 'STRATEGY', width: 12 }
      ];
      
      return <Table columns={columns} data={data.signals} />;
      
    case 'triggered':
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Signal triggered successfully</Text>
          <Text>  Signal: {data.signal}</Text>
          <Text>  Session ID: {data.sessionId}</Text>
          <Text>  Status: {data.status}</Text>
          <Text> </Text>
          <Text color="gray">Monitor the session with: atlas logs {data.sessionId}</Text>
        </Box>
      );
      
    case 'history':
      return <Text color="gray">Signal history not yet implemented</Text>;
      
    default:
      return <Text>Unknown output type: {data.type}</Text>;
  }
}