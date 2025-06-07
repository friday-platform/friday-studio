# Atlas CLI Shorthand System

## Design Principles
1. **Single letter for primary commands** (w, s, a, l)
2. **Two letters for sub-commands** when needed
3. **Memorable and intuitive** mappings
4. **No conflicts** between shorthands

## Proposed Shorthands

### Workspace Commands
```bash
atlas w                    # atlas workspace (shows help)
atlas wi [name]            # atlas workspace init
atlas ws                   # atlas workspace serve  
atlas wl                   # atlas workspace list
atlas wt                   # atlas workspace status (think: workspace sTatus)
```

### Session Commands
```bash
atlas s                    # atlas session list (default)
atlas sl                   # atlas session list (explicit)
atlas sg <id>              # atlas session get
atlas sc <id>              # atlas session cancel
atlas ps                   # atlas session list (process style - already exists)
```

### Signal Commands
```bash
atlas g                    # atlas signal (think: siGnal)
atlas gl                   # atlas signal list
atlas gt <name> -d '{}'    # atlas signal trigger
atlas gh                   # atlas signal history
```

### Agent Commands  
```bash
atlas a                    # atlas agent list (default)
atlas al                   # atlas agent list (explicit)
atlas ad <name>            # atlas agent describe
atlas at <name> -m "..."   # atlas agent test
```

### Logs Command
```bash
atlas l <id>               # atlas logs <session-id>
atlas logs <id>            # full command still works
```

### Help
```bash
atlas h                    # atlas help
atlas ?                    # atlas help (alternative)
```

## Implementation Example

Update cli.tsx to support these shorthands:

```typescript
// Map shorthands to full commands
const shorthandMap = {
  'w': 'workspace',
  'wi': ['workspace', 'init'],
  'ws': ['workspace', 'serve'],
  'wl': ['workspace', 'list'],
  'wt': ['workspace', 'status'],
  
  's': ['session', 'list'],
  'sl': ['session', 'list'],
  'sg': ['session', 'get'],
  'sc': ['session', 'cancel'],
  
  'g': 'signal',
  'gl': ['signal', 'list'],
  'gt': ['signal', 'trigger'],
  'gh': ['signal', 'history'],
  
  'a': ['agent', 'list'],
  'al': ['agent', 'list'],
  'ad': ['agent', 'describe'],
  'at': ['agent', 'test'],
  
  'l': 'logs',
  'h': 'help',
  '?': 'help'
};
```

## Usage Examples

```bash
# Quick status check
atlas wt                   # workspace status
atlas ps                   # process/session list
atlas al                   # agent list

# Common workflow
atlas ws                   # start server
atlas gt telephone-message -d '{"message": "Hello"}'  # trigger signal
atlas l sess_abc123        # view logs

# Quick navigation
atlas w                    # show workspace commands
atlas s                    # list sessions
atlas a                    # list agents
```

## Benefits

1. **Faster typing** - Common operations are 2-3 characters
2. **Muscle memory** - Consistent patterns (l for list, t for trigger/test)
3. **Discoverable** - Single letter shows available sub-commands
4. **Compatible** - Full commands still work