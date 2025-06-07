import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { exists } from "https://deno.land/std@0.208.0/fs/exists.ts";
import * as yaml from "https://deno.land/std@0.208.0/yaml/mod.ts";
import { Table, Column } from '../components/Table.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

export interface AgentCommandProps {
  subcommand?: string;
  args: string[];
  flags: any;
}

export function AgentCommand({ subcommand, args, flags }: AgentCommandProps) {
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
          case 'describe':
            await handleDescribe(args[0]);
            break;
          case 'test':
            await handleTest(args[0], flags);
            break;
          default:
            setError(`Unknown agent command: ${subcommand}. Available: list, describe, test`);
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
    const agents = Object.entries(config.agents || {}).map(([id, agent]: [string, any]) => ({
      name: id,
      type: agent.type || 'local',
      model: agent.model || config.supervisor?.model || 'claude-4-sonnet-20250514',
      status: 'ready',
      purpose: agent.purpose || 'No description'
    }));
    
    setData({ type: 'list', agents });
    setStatus('ready');
  }
  
  async function handleDescribe(agentName: string | undefined) {
    if (!agentName) {
      throw new Error('Agent name required. Usage: atlas agent describe <name>');
    }
    
    if (!await exists('workspace.yml')) {
      throw new Error('No workspace.yml found. Run "atlas workspace init" first.');
    }
    
    const config = yaml.parse(await Deno.readTextFile('workspace.yml')) as any;
    const agentConfig = config.agents?.[agentName];
    
    if (!agentConfig) {
      throw new Error(`Agent '${agentName}' not found in workspace configuration`);
    }
    
    setData({ 
      type: 'detail', 
      agent: {
        name: agentName,
        ...agentConfig,
        model: agentConfig.model || config.supervisor?.model || 'claude-4-sonnet-20250514'
      }
    });
    setStatus('ready');
  }
  
  async function handleTest(agentName: string | undefined, flags: any) {
    if (!agentName) {
      throw new Error('Agent name required. Usage: atlas agent test <name> --message "..."');
    }
    
    const message = flags.message || flags.m;
    if (!message) {
      throw new Error('Message required. Usage: atlas agent test <name> --message "..."');
    }
    
    // TODO: Implement direct agent testing
    setData({ 
      type: 'test', 
      agent: agentName,
      message,
      result: 'Agent testing not yet implemented. Use signal trigger to test agents in a workflow.'
    });
    setStatus('ready');
  }
  
  if (status === 'loading') {
    return <Text>Loading...</Text>;
  }
  
  if (status === 'error') {
    return <Text color="red">Error: {error}</Text>;
  }
  
  return <AgentOutput data={data} />;
}

function AgentOutput({ data }: { data: any }) {
  if (!data) return null;
  
  switch (data.type) {
    case 'list':
      if (data.agents.length === 0) {
        return <Text color="gray">No agents configured</Text>;
      }
      
      const columns: Column[] = [
        { key: 'name', label: 'AGENT', width: 25 },
        { key: 'type', label: 'TYPE', width: 10 },
        { key: 'model', label: 'MODEL', width: 30 },
        { key: 'status', label: 'STATUS', width: 10 },
        { key: 'purpose', label: 'PURPOSE', width: 45 }
      ];
      
      return <Table columns={columns} data={data.agents} />;
      
    case 'detail':
      const agent = data.agent;
      return (
        <Box flexDirection="column">
          <Text bold color="cyan">Agent Details</Text>
          <Text>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
          <Text>Name: <Text color="white">{agent.name}</Text></Text>
          <Text>Type: <Text color="white">{agent.type}</Text></Text>
          <Text>Model: <Text color="white">{agent.model}</Text></Text>
          {agent.path && <Text>Path: <Text color="gray">{agent.path}</Text></Text>}
          {agent.purpose && <Text>Purpose: <Text color="white">{agent.purpose}</Text></Text>}
          <Text> </Text>
          {agent.prompts && (
            <>
              <Text>Prompts:</Text>
              {Object.entries(agent.prompts).map(([key, value]: [string, any]) => (
                <Text key={key}>  {key}: <Text color="gray">{String(value).substring(0, 50)}...</Text></Text>
              ))}
            </>
          )}
        </Box>
      );
      
    case 'test':
      return (
        <Box flexDirection="column">
          <Text color="yellow">{data.result}</Text>
        </Box>
      );
      
    default:
      return <Text>Unknown output type: {data.type}</Text>;
  }
}