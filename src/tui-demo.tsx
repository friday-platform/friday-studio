import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { FullScreenBox } from 'fullscreen-ink';

// Mock data
const mockConversation = [
  { type: 'user', content: 'Initialize workspace for frontend dev team', timestamp: '14:32:15' },
  { type: 'assistant', content: 'Creating workspace with React/TypeScript agents...', timestamp: '14:32:16' },
  { type: 'system', content: '✓ Agent: code-reviewer initialized', timestamp: '14:32:18' },
  { type: 'system', content: '✓ Agent: test-runner initialized', timestamp: '14:32:19' },
  { type: 'assistant', content: 'Workspace "frontend-dev" ready with 3 agents', timestamp: '14:32:20' },
];

const mockAgents = [
  { name: 'code-reviewer', status: 'busy', task: 'Reviewing PR #247' },
  { name: 'test-runner', status: 'idle', task: null },
  { name: 'accessibility-checker', status: 'ready', task: null },
];

const TUIDemo: React.FC = () => {
  const [input, setInput] = useState('');
  const [conversation, setConversation] = useState(mockConversation);
  const [currentPanel, setCurrentPanel] = useState<'diagnostic' | 'artifact'>('diagnostic');
  const { exit } = useApp();
  
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      exit();
    } else if (key.tab) {
      setCurrentPanel(prev => prev === 'diagnostic' ? 'artifact' : 'diagnostic');
    } else if (key.return) {
      if (input.trim()) {
        const newMessage = {
          type: 'user' as const,
          content: input.trim(),
          timestamp: new Date().toTimeString().slice(0, 8)
        };
        setConversation(prev => [...prev, newMessage]);
        setInput('');
        
        // Mock response
        setTimeout(() => {
          const response = {
            type: 'assistant' as const,
            content: 'Processing your request...',
            timestamp: new Date().toTimeString().slice(0, 8)
          };
          setConversation(prev => [...prev, response]);
        }, 300);
      }
    } else if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
    } else if (inputChar && !key.ctrl && !key.meta && !key.escape) {
      setInput(prev => prev + inputChar);
    }
  });

  return (
    <FullScreenBox flexDirection="column">
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} paddingX={2}>
          <Text bold color="blue">💬 Session Conversation</Text>
          <Box flexDirection="column" marginTop={1}>
            {conversation.slice(-6).map((msg, i) => (
              <Text key={i}>
                <Text color="gray">[{msg.timestamp}] </Text>
                <Text color={
                  msg.type === 'user' ? 'cyan' : 
                  msg.type === 'assistant' ? 'green' : 'yellow'
                }>
                  {msg.type === 'user' ? '❯ ' : 
                   msg.type === 'assistant' ? '🤖 ' : '⚡ '}
                  {msg.content}
                </Text>
              </Text>
            ))}
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingX={2}>
          <Text bold color="magenta">🔍 Diagnostics (Tab)</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Agent Status:</Text>
            {mockAgents.map((agent, i) => (
              <Text key={i} color={
                agent.status === 'busy' ? 'yellow' :
                agent.status === 'idle' ? 'gray' : 'green'
              }>
                {agent.status === 'busy' ? '⚠️' :
                 agent.status === 'idle' ? '💤' : '✅'} {agent.name}
                {agent.task && ` - ${agent.task}`}
              </Text>
            ))}
            <Text bold>Memory: 54MB</Text>
          </Box>
        </Box>
      </Box>

      {/* Input Area */}
      <Box borderStyle="single" borderColor="green">
        <Box width="75%" paddingX={1}>
          <Text bold color="green">Atlas Prompt</Text>
          <Text>❯ {input}<Text backgroundColor="white" color="black"> </Text></Text>
        </Box>
        <Box width="25%" paddingX={1} borderLeft borderColor="green">
          <Text bold color="green"> Hints</Text>
          <Text color="gray"> Tab: Switch  Ctrl+C: Exit</Text>
        </Box>
      </Box>

      {/* Status Bar */}
      <Box paddingX={1}>
        <Text bold color="yellow">🏢 frontend-dev-team </Text>
        <Text color="green">● </Text>
        <Text>Sessions: {conversation.filter(m => m.type === 'user').length} | Agents: 1 running, 1 idle, 1 ready</Text>
      </Box>
    </FullScreenBox>
  );
};

export default TUIDemo;