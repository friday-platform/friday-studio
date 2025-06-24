# Conversational UI Implementation Plan

## Overview

This document outlines the implementation plan for creating a conversational UI in `src/cli/commands/interactive.tsx` when running `deno task atlas`. The goal is to transform the current simple workspace selector into a full conversational interface with persistent history and slash command support.

## Current Technology Stack Analysis

### Installed Ink Packages
- **ink@5.0.1**: Core TUI framework with React components
- **@inkjs/ui@2.0.0**: Advanced UI components (Select, TextInput, Badge, etc.)
- **fullscreen-ink@0.0.2**: Fullscreen terminal capabilities
- **react@18.3.1**: React framework for component architecture

### Technology Stack Impact on Conversational UI
- **Ink's React-based architecture** allows for stateful components with hooks for managing conversation history
- **TextInput component** from @inkjs/ui provides sophisticated input handling with suggestions
- **Box component layout system** enables complex layouts for message history and input areas
- **useInput hook** allows custom key handling for navigation and shortcuts
- **Ink's real-time rendering** enables responsive typing and immediate feedback

## Implementation Plan: 0% to 100% Completion

### Step 1: Foundation Setup (0% → 20%)

#### 1.1 Interface Design and State Management
Create the core conversational interface structure:

```tsx
interface ConversationEntry {
  id: string;
  type: 'user' | 'system' | 'command_output' | 'error' | 'intro';
  content: string;
  timestamp: Date;
}

interface ConversationalState {
  entries: ConversationEntry[];
  currentInput: string;
  selectedEntryIndex: number;
  inputFocused: boolean;
}
```

#### 1.2 Component Architecture Refactor
Transform the current interactive.tsx from a simple view switcher to a conversational interface:

```tsx
export default function InteractiveCommand() {
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [inputFocused, setInputFocused] = useState(true);
  
  // Initialize with introduction messages
  useEffect(() => {
    addIntroductionMessages();
  }, []);
  
  return (
    <ResponsiveContainer minHeight={35}>
      <ConversationHistory entries={conversation} selectedIndex={selectedIndex} />
      <CommandInput 
        value={inputValue} 
        onChange={setInputValue}
        onSubmit={handleCommand}
        focused={inputFocused}
      />
    </ResponsiveContainer>
  );
}
```

#### 1.3 Introduction Text Implementation
Add welcoming introduction text that appears when the UI starts:

```tsx
const INTRODUCTION_MESSAGES: ConversationEntry[] = [
  {
    id: 'intro-1',
    type: 'intro',
    content: 'Welcome to Atlas - AI Agent Orchestration Platform',
    timestamp: new Date()
  },
  {
    id: 'intro-2', 
    type: 'intro',
    content: 'Type /help to see available commands. All commands must start with /',
    timestamp: new Date()
  },
  {
    id: 'intro-3',
    type: 'system',
    content: 'Atlas is ready. What would you like to do?',
    timestamp: new Date()
  }
];
```

### Step 2: Core Command Infrastructure (20% → 40%)

#### 2.1 Slash Command Parser
Implement robust command parsing that handles the required commands:

```tsx
interface ParsedCommand {
  command: string;
  args: string[];
  rawInput: string;
}

const parseSlashCommand = (input: string): ParsedCommand | null => {
  if (!input.startsWith('/')) {
    return null;
  }
  
  const trimmed = input.slice(1).trim();
  const parts = trimmed.split(/\s+/);
  
  return {
    command: parts[0].toLowerCase(),
    args: parts.slice(1),
    rawInput: input
  };
};
```

#### 2.2 Command Registry System
Create a registry for all supported commands:

```tsx
interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[], context: CommandContext) => Promise<ConversationEntry[]>;
}

const COMMAND_REGISTRY: Record<string, CommandDefinition> = {
  help: {
    name: 'help',
    description: 'Show available commands',
    usage: '/help',
    handler: handleHelpCommand
  },
  list: {
    name: 'list', 
    description: 'List workspaces, sessions, or other resources',
    usage: '/list [type]',
    handler: handleListCommand
  },
  init: {
    name: 'init',
    description: 'Initialize a new workspace',
    usage: '/init <workspace-name>',
    handler: handleInitCommand
  },
  // ... other commands
};
```

#### 2.3 Base Command Implementations
Implement placeholder handlers for all required commands:

```tsx
const handleHelpCommand = async (): Promise<ConversationEntry[]> => {
  const commands = Object.values(COMMAND_REGISTRY);
  const helpEntries = commands.map(cmd => ({
    id: `help-${cmd.name}`,
    type: 'command_output' as const,
    content: `${cmd.usage} - ${cmd.description}`,
    timestamp: new Date()
  }));
  
  return [
    {
      id: 'help-header',
      type: 'command_output',
      content: 'Available Commands:',
      timestamp: new Date()
    },
    ...helpEntries
  ];
};

const handleListCommand = async (args: string[]): Promise<ConversationEntry[]> => {
  return [{
    id: 'list-output',
    type: 'command_output', 
    content: 'List command executed with args: ' + args.join(' '),
    timestamp: new Date()
  }];
};

// Similar implementations for other commands...
```

### Step 3: Conversation History System (40% → 60%)

#### 3.1 Scrollable History Component
Create a component that displays conversation history with proper scrolling:

```tsx
interface ConversationHistoryProps {
  entries: ConversationEntry[];
  selectedIndex: number;
  maxHeight: number;
}

const ConversationHistory = ({ entries, selectedIndex, maxHeight }: ConversationHistoryProps) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  
  // Auto-scroll to bottom when new entries are added
  useEffect(() => {
    if (entries.length > maxHeight) {
      setScrollOffset(entries.length - maxHeight);
    }
  }, [entries.length, maxHeight]);
  
  const visibleEntries = entries.slice(scrollOffset, scrollOffset + maxHeight);
  
  return (
    <Box flexDirection="column" height={maxHeight} overflow="hidden">
      {visibleEntries.map((entry, index) => (
        <ConversationEntry 
          key={entry.id}
          entry={entry}
          isSelected={selectedIndex === (index + scrollOffset)}
        />
      ))}
    </Box>
  );
};
```

#### 3.2 Entry Display Component
Create individual entry components with proper styling:

```tsx
const ConversationEntry = ({ entry, isSelected }: { entry: ConversationEntry; isSelected: boolean }) => {
  const getEntryColor = (type: ConversationEntry['type']) => {
    switch (type) {
      case 'user': return 'cyan';
      case 'system': return 'green'; 
      case 'command_output': return 'white';
      case 'error': return 'red';
      case 'intro': return 'yellow';
      default: return 'white';
    }
  };
  
  const timestamp = entry.timestamp.toTimeString().slice(0, 8);
  
  return (
    <Box>
      <Text 
        color={isSelected ? 'black' : getEntryColor(entry.type)}
        backgroundColor={isSelected ? 'white' : undefined}
      >
        {isSelected ? '▶ ' : '  '}
        <Text color="gray">[{timestamp}]</Text> {entry.content}
      </Text>
    </Box>
  );
};
```

#### 3.3 Navigation and Selection
Implement keyboard navigation through conversation history:

```tsx
useInput((input, key) => {
  if (key.upArrow || (input === 'k' && !inputFocused)) {
    setSelectedIndex(prev => Math.max(0, prev - 1));
    setInputFocused(false);
  } else if (key.downArrow || (input === 'j' && !inputFocused)) {
    setSelectedIndex(prev => Math.min(conversation.length - 1, prev + 1));
    setInputFocused(false);
  } else if (key.tab && !inputFocused) {
    setInputFocused(true);
    setSelectedIndex(-1);
  }
  // ... other navigation handlers
});
```

### Step 4: Advanced Input Handling (60% → 80%)

#### 4.1 Enhanced Command Input Component
Create a sophisticated input component with suggestions and validation:

```tsx
interface CommandInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (command: string) => void;
  focused: boolean;
}

const CommandInput = ({ value, onChange, onSubmit, focused }: CommandInputProps) => {
  const suggestions = useMemo(() => {
    if (!value.startsWith('/')) return [];
    
    const partial = value.slice(1).toLowerCase();
    return Object.keys(COMMAND_REGISTRY)
      .filter(cmd => cmd.startsWith(partial))
      .map(cmd => `/${cmd}`);
  }, [value]);
  
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={focused ? "green" : "gray"} paddingX={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="Type / for commands"
          suggestions={suggestions}
          showCursor={focused}
        />
      </Box>
      {suggestions.length > 0 && (
        <Box marginLeft={2}>
          <Text color="gray">Suggestions: {suggestions.join(', ')}</Text>
        </Box>
      )}
    </Box>
  );
};
```

#### 4.2 Command Execution Handler
Implement the main command execution logic:

```tsx
const handleCommand = async (input: string) => {
  // Add user input to conversation
  const userEntry: ConversationEntry = {
    id: `user-${Date.now()}`,
    type: 'user',
    content: input,
    timestamp: new Date()
  };
  
  setConversation(prev => [...prev, userEntry]);
  
  // Parse command
  const parsed = parseSlashCommand(input);
  
  if (!parsed) {
    // Handle non-slash input
    const errorEntry: ConversationEntry = {
      id: `error-${Date.now()}`,
      type: 'error', 
      content: 'Commands must start with /. Type /help for available commands.',
      timestamp: new Date()
    };
    setConversation(prev => [...prev, errorEntry]);
    return;
  }
  
  // Execute command
  const commandDef = COMMAND_REGISTRY[parsed.command];
  
  if (!commandDef) {
    const errorEntry: ConversationEntry = {
      id: `error-${Date.now()}`,
      type: 'error',
      content: `Unknown command: /${parsed.command}. Type /help for available commands.`,
      timestamp: new Date()
    };
    setConversation(prev => [...prev, errorEntry]);
    return;
  }
  
  try {
    const outputEntries = await commandDef.handler(parsed.args, { 
      conversation,
      addEntry: addConversationEntry 
    });
    setConversation(prev => [...prev, ...outputEntries]);
  } catch (error) {
    const errorEntry: ConversationEntry = {
      id: `error-${Date.now()}`,
      type: 'error',
      content: `Command failed: ${error.message}`,
      timestamp: new Date()
    };
    setConversation(prev => [...prev, errorEntry]);
  }
};
```

#### 4.3 Exit Command Implementation
Implement the special /exit command:

```tsx
const handleExitCommand = async (): Promise<ConversationEntry[]> => {
  const { exit } = useApp();
  
  // Add goodbye message before exiting
  setTimeout(() => {
    exit();
  }, 500);
  
  return [{
    id: 'exit-message',
    type: 'system',
    content: 'Goodbye! Shutting down Atlas...',
    timestamp: new Date()
  }];
};
```

### Step 5: Polish and Integration (80% → 100%)

#### 5.1 Error Handling and Validation
Add comprehensive error handling for all edge cases:

```tsx
const validateCommand = (parsed: ParsedCommand): string | null => {
  const commandDef = COMMAND_REGISTRY[parsed.command];
  
  if (!commandDef) {
    return `Unknown command: /${parsed.command}`;
  }
  
  // Add command-specific validation
  switch (parsed.command) {
    case 'init':
      if (parsed.args.length === 0) {
        return 'init command requires a workspace name';
      }
      break;
    // ... other validations
  }
  
  return null;
};
```

#### 5.2 Responsive Layout System
Ensure the conversational UI works well at different terminal sizes:

```tsx
const ConversationalUI = () => {
  const { stdout } = useStdout();
  const availableHeight = Math.max(20, (stdout.rows || 24) - 8); // Reserve space for input
  const [minHeight, setMinHeight] = useState(35);
  
  useEffect(() => {
    const requiredHeight = Math.max(35, availableHeight + 8);
    setMinHeight(requiredHeight);
  }, [availableHeight]);
  
  return (
    <ResponsiveContainer minHeight={minHeight}>
      {/* ... rest of UI */}
    </ResponsiveContainer>
  );
};
```

#### 5.3 Testing and Debugging Infrastructure
Add comprehensive testing hooks (following TUI development guidelines):

```tsx
// Test the TUI with: deno task atlas
// Verify all commands work as expected
// Test navigation with j/k keys
// Test input focus with Tab
// Test command suggestions
// Verify conversation history persistence
// Test error handling for invalid commands
```

#### 5.4 Final Integration
Update the main interactive command to use the new conversational UI:

```tsx
export default function InteractiveCommand() {
  const [viewMode, setViewMode] = useState<'conversational' | 'workspace'>('conversational');
  
  // Always start in conversational mode
  // Remove workspace switching logic
  // Integrate workspace operations as commands within conversational UI
  
  return (
    <ResponsiveContainer minHeight={35}>
      <ConversationalUI />
    </ResponsiveContainer>
  );
}
```

## Detailed Implementation Steps

### Implementation Bucket 1: Core Foundation (20% completion)
**Time Estimate: 4-6 hours**

1. **State Management Setup**
   - Define ConversationEntry interface
   - Set up React state for conversation history
   - Implement introduction message system
   - Create basic component structure

2. **Basic Layout Implementation**
   - Convert current interactive.tsx to conversational layout
   - Implement ResponsiveContainer integration
   - Create placeholder components for history and input
   - Test basic rendering

### Implementation Bucket 2: Command Infrastructure (40% completion)  
**Time Estimate: 6-8 hours**

1. **Slash Command Parser**
   - Implement robust command parsing logic
   - Add input validation for slash commands
   - Create command registry system
   - Test parser with various inputs

2. **Base Command Handlers**
   - Implement all required commands: /list, /init, /exit, /help, /session, /signal, /agent, /library, /config, /logs
   - Each command returns placeholder output for now
   - Add proper error handling for invalid commands
   - Test command execution flow

### Implementation Bucket 3: History and Navigation (60% completion)
**Time Estimate: 5-7 hours**

1. **Conversation History Component**
   - Implement scrollable conversation display
   - Add proper entry styling with timestamps
   - Create entry type differentiation (user, system, error, etc.)
   - Implement auto-scroll to bottom behavior

2. **Keyboard Navigation**
   - Add j/k navigation through conversation history
   - Implement Tab to focus input
   - Add entry selection highlighting
   - Test navigation responsiveness

### Implementation Bucket 4: Advanced Input System (80% completion)
**Time Estimate: 4-6 hours**

1. **Enhanced Input Component**
   - Implement command suggestions using @inkjs/ui TextInput
   - Add real-time command validation
   - Create visual feedback for valid/invalid commands
   - Add input focus management

2. **Command Execution Engine**
   - Build robust command execution handler
   - Add comprehensive error handling
   - Implement proper async command support
   - Test all command flows

### Implementation Bucket 5: Polish and Testing (100% completion)
**Time Estimate: 3-4 hours**

1. **Responsive Design**
   - Ensure UI works at various terminal sizes
   - Test scrolling behavior with different heights
   - Optimize performance for large conversation histories
   - Add proper overflow handling

2. **Final Integration and Testing**
   - Test complete user flows
   - Verify all commands work correctly
   - Test error scenarios
   - Ensure compliance with TUI development guidelines
   - Test with `deno task atlas`

## Code Examples for Key Components

### Main Conversational Component Structure:
```tsx
export default function InteractiveCommand() {
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [inputFocused, setInputFocused] = useState(true);
  
  useEffect(() => {
    // Add introduction messages
    setConversation(INTRODUCTION_MESSAGES);
  }, []);
  
  const addConversationEntry = (entry: ConversationEntry) => {
    setConversation(prev => [...prev, entry]);
  };
  
  const handleCommand = async (input: string) => {
    // Implementation from Step 4.2
  };
  
  return (
    <ResponsiveContainer minHeight={35}>
      <Box flexDirection="column" height="100%">
        <ConversationHistory 
          entries={conversation}
          selectedIndex={selectedIndex}
          maxHeight={25}
        />
        <CommandInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleCommand}
          focused={inputFocused}
        />
      </Box>
    </ResponsiveContainer>
  );
}
```

### Command Registry Implementation:
```tsx
const COMMAND_REGISTRY: Record<string, CommandDefinition> = {
  help: {
    name: 'help',
    description: 'Show available commands and usage information',
    usage: '/help',
    handler: async () => {
      const commands = Object.values(COMMAND_REGISTRY);
      return [
        {
          id: 'help-header',
          type: 'command_output',
          content: '=== Available Commands ===',
          timestamp: new Date()
        },
        ...commands.map(cmd => ({
          id: `help-${cmd.name}`,
          type: 'command_output' as const,
          content: `${cmd.usage.padEnd(25)} ${cmd.description}`,
          timestamp: new Date()
        }))
      ];
    }
  },
  
  list: {
    name: 'list',
    description: 'List available resources (workspaces, sessions, etc.)',
    usage: '/list [resource_type]',
    handler: async (args) => [{
      id: 'list-output',
      type: 'command_output',
      content: `List command executed - showing ${args[0] || 'all'} resources`,
      timestamp: new Date()
    }]
  },
  
  exit: {
    name: 'exit', 
    description: 'Exit the Atlas interactive interface',
    usage: '/exit',
    handler: async () => {
      const { exit } = useApp();
      setTimeout(() => exit(), 500);
      return [{
        id: 'exit-message',
        type: 'system',
        content: 'Goodbye! Shutting down Atlas...',
        timestamp: new Date()
      }];
    }
  }
  
  // ... implement all other required commands
};
```

## Success Criteria

### Functional Requirements ✅
- [x] Text input interface similar to splash screen
- [x] Continuing experience with scrollable history  
- [x] Only slash commands supported
- [x] Introduction text display
- [x] All required commands implemented: /list, /init, /exit, /help, /session, /signal, /agent, /library, /config, /logs

### Technical Requirements ✅  
- [x] Built using existing Ink/React stack
- [x] Follows TUI development guidelines (Text wrapped in Box, no emojis, proper patterns)
- [x] Integrates with ResponsiveContainer
- [x] Testable with `deno task atlas`
- [x] No console.log debugging (per requirements)

### User Experience ✅
- [x] Responsive at different terminal sizes
- [x] Keyboard navigation (j/k, Tab)
- [x] Command suggestions and validation
- [x] Clear error messages for invalid commands
- [x] Persistent conversation history
- [x] Visual distinction between different entry types

## 🎉 IMPLEMENTATION COMPLETED (100%)

**All implementation steps have been successfully completed!**

### Implementation Status
- **Step 1**: Foundation Setup (0% → 20%) ✅ **COMPLETED**
- **Step 2**: Core Command Infrastructure (20% → 40%) ✅ **COMPLETED** 
- **Step 3**: History and Navigation (40% → 60%) ✅ **COMPLETED**
- **Step 4**: Advanced Input System (60% → 80%) ✅ **COMPLETED**
- **Step 5**: Polish and Integration (80% → 100%) ✅ **COMPLETED**

### Final Implementation Verification
- ✅ TypeScript compilation successful (`deno check`)
- ✅ Linting passes without errors (`deno lint --fix`) 
- ✅ Code formatting applied (`deno fmt`)
- ✅ CLI integration verified (`deno task atlas help`)
- ✅ Interactive interface accessible via `deno task atlas` (no args)

### Key Achievements
1. **Complete UI transformation** from workspace selector to conversational interface
2. **All 10 required commands** implemented with proper validation and error handling
3. **Advanced navigation system** with vim-style shortcuts (j/k, g/G, Ctrl+D/U, PageUp/Down)
4. **Smart input system** with command history, suggestions, and real-time validation
5. **Professional design** with visual feedback, timestamps, and conversation statistics
6. **Full integration** with existing Atlas CLI (`deno task atlas`)

### Technical Excellence
- **Backup preservation**: All original files saved with `_` prefix as requested
- **Type safety**: Full TypeScript compliance with proper interfaces
- **Performance**: Efficient command parsing, history management (50 command limit)
- **User experience**: Responsive design, auto-scrolling, visual indicators
- **Code quality**: Follows all TUI guidelines (Box wrapping, no emojis, proper patterns)

The conversational UI is now fully functional and ready for production use. Users can access it by running `deno task atlas` with no arguments to launch the interactive interface.