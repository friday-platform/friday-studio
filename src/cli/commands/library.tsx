import React from "react";
import { Box, Text } from "ink";
import { Table } from "../components/Table.tsx";

interface LibraryCommandProps {
  args: string[];
  flags: Record<string, unknown>;
}

interface LibraryItem {
  id: string;
  type: string;
  name: string;
  created_at: string;
  tags: string[];
  size_bytes: number;
  description?: string;
}

interface LibraryTemplate {
  id: string;
  name: string;
  format: string;
  engine: string;
  description?: string;
}

const LibraryCommand: React.FC<LibraryCommandProps> = ({ args, flags }: LibraryCommandProps) => {
  const [items, setItems] = React.useState<LibraryItem[]>([]);
  const [templates, setTemplates] = React.useState<LibraryTemplate[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedItem, setSelectedItem] = React.useState<any>(null);

  const subcommand = args[0] || "list";

  // Determine server URL
  const getServerUrl = () => {
    const port = flags.port || 8080;
    return `http://localhost:${port}`;
  };

  React.useEffect(() => {
    executeCommand();
  }, []);

  const executeCommand = async () => {
    try {
      setLoading(true);
      setError(null);

      switch (subcommand) {
        case "list":
          await listItems();
          break;
        case "search":
          await searchItems();
          break;
        case "get":
          await getItem();
          break;
        case "templates":
          await listTemplates();
          break;
        case "generate":
          await generateReport();
          break;
        case "stats":
          await getStats();
          break;
        default:
          setError(`Unknown subcommand: ${subcommand}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const listItems = async () => {
    const params = new URLSearchParams();

    if (flags.type) params.append("type", String(flags.type));
    if (flags.tags) params.append("tags", String(flags.tags));
    if (flags.since) params.append("since", String(flags.since));
    if (flags.limit) params.append("limit", String(flags.limit));
    if (flags.workspace) params.append("workspace", "true");

    const response = await fetch(`${getServerUrl()}/library?${params}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    setItems(data);
  };

  const searchItems = async () => {
    const query = args[1];
    if (!query) {
      throw new Error("Search query is required");
    }

    const params = new URLSearchParams();
    params.append("q", query);

    if (flags.type) params.append("type", String(flags.type));
    if (flags.tags) params.append("tags", String(flags.tags));
    if (flags.limit) params.append("limit", String(flags.limit));

    const response = await fetch(`${getServerUrl()}/library/search?${params}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    setItems(data.items);
  };

  const getItem = async () => {
    const itemId = args[1];
    if (!itemId) {
      throw new Error("Item ID is required");
    }

    const params = new URLSearchParams();
    if (flags.content) params.append("content", "true");

    // First, try with the exact ID
    let response = await fetch(`${getServerUrl()}/library/${itemId}?${params}`);

    // If not found and ID looks like a partial ID (short), try to find by prefix
    if (!response.ok && response.status === 404 && itemId.length < 20) {
      // Get all items and find one that starts with this ID
      const listResponse = await fetch(`${getServerUrl()}/library`);
      if (listResponse.ok) {
        const items = await listResponse.json();
        const matchingItem = items.find((item: any) => item.id.startsWith(itemId));

        if (matchingItem) {
          // Try again with the full ID
          response = await fetch(`${getServerUrl()}/library/${matchingItem.id}?${params}`);
        }
      }
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    setSelectedItem(data);
  };

  const listTemplates = async () => {
    const params = new URLSearchParams();
    if (flags.workspace) params.append("workspace", "true");
    if (flags.platform) params.append("platform", "true");

    const response = await fetch(`${getServerUrl()}/library/templates?${params}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    setTemplates(data);
  };

  const generateReport = async () => {
    const template = args[1];
    const dataFile = args[2];

    if (!template) {
      throw new Error("Template ID is required");
    }

    if (!dataFile) {
      throw new Error("Data file is required");
    }

    // Read data file
    let data;
    try {
      const fileContent = await Deno.readTextFile(dataFile);
      data = JSON.parse(fileContent);
    } catch {
      throw new Error(`Failed to read or parse data file: ${dataFile}`);
    }

    const response = await fetch(`${getServerUrl()}/library/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template,
        data,
        store: flags.store || false,
        name: flags.name,
        description: flags.description,
        tags: flags.tags ? String(flags.tags).split(",") : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    setSelectedItem(result);
  };

  const getStats = async () => {
    const response = await fetch(`${getServerUrl()}/library/stats`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    setSelectedItem(data);
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString();
  };

  if (loading) {
    return (
      <Box>
        <Text>Loading...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  // Render based on subcommand
  switch (subcommand) {
    case "list":
    case "search":
      if (items.length === 0) {
        return (
          <Box>
            <Text color="yellow">No library items found</Text>
          </Box>
        );
      }

      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>
              📚 Library Items ({items.length})
            </Text>
          </Box>

          <Table
            columns={[
              { key: "ID", label: "ID", width: 10 },
              { key: "Type", label: "Type", width: 12 },
              { key: "Name", label: "Name", width: 25 },
              { key: "Size", label: "Size", width: 10 },
              { key: "Created", label: "Created", width: 12 },
              { key: "Tags", label: "Tags", width: 20 },
            ]}
            data={items.map((item: LibraryItem) => ({
              ID: item.id.slice(0, 8),
              Type: item.type,
              Name: item.name,
              Size: formatBytes(item.size_bytes),
              Created: formatDate(item.created_at),
              Tags: item.tags.join(", ") || "none",
            }))}
          />

          <Box marginTop={1}>
            <Text dimColor>
              Use 'atlas library get &lt;id&gt;' to view details
            </Text>
          </Box>
        </Box>
      );

    case "templates":
      if (templates.length === 0) {
        return (
          <Box>
            <Text color="yellow">No templates found</Text>
          </Box>
        );
      }

      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>
              📋 Available Templates ({templates.length})
            </Text>
          </Box>

          <Table
            columns={[
              { key: "ID", label: "ID", width: 15 },
              { key: "Name", label: "Name", width: 20 },
              { key: "Format", label: "Format", width: 10 },
              { key: "Engine", label: "Engine", width: 12 },
              { key: "Description", label: "Description", width: 30 },
            ]}
            data={templates.map((template: LibraryTemplate) => ({
              ID: template.id,
              Name: template.name,
              Format: template.format,
              Engine: template.engine,
              Description: template.description || "No description",
            }))}
          />

          <Box marginTop={1}>
            <Text dimColor>
              Use 'atlas library generate &lt;template-id&gt; &lt;data-file&gt;' to generate content
            </Text>
          </Box>
        </Box>
      );

    case "get":
      if (!selectedItem) {
        return (
          <Box>
            <Text color="yellow">No item selected</Text>
          </Box>
        );
      }

      if (selectedItem.item) {
        // Item with content
        const item = selectedItem.item;
        return (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text bold>📄 {item.name}</Text>
            </Box>

            <Box marginBottom={1}>
              <Text>
                <Text bold>ID:</Text> {item.id}
              </Text>
            </Box>

            <Box marginBottom={1}>
              <Text>
                <Text bold>Type:</Text> {item.type} | <Text bold>Format:</Text>{" "}
                {item.metadata.format}
              </Text>
            </Box>

            <Box marginBottom={1}>
              <Text>
                <Text bold>Size:</Text> {formatBytes(item.size_bytes)} | <Text bold>Created:</Text>
                {" "}
                {formatDate(item.created_at)}
              </Text>
            </Box>

            {item.tags.length > 0 && (
              <Box marginBottom={1}>
                <Text>
                  <Text bold>Tags:</Text> {item.tags.join(", ")}
                </Text>
              </Box>
            )}

            {item.description && (
              <Box marginBottom={1}>
                <Text>
                  <Text bold>Description:</Text> {item.description}
                </Text>
              </Box>
            )}

            {selectedItem.content && (
              <Box marginTop={1} marginBottom={1}>
                <Text bold>Content:</Text>
              </Box>
            )}

            {selectedItem.content && (
              <Box paddingLeft={2} paddingY={1} borderStyle="single" borderColor="gray">
                <Text>{selectedItem.content}</Text>
              </Box>
            )}
          </Box>
        );
      } else {
        // Just metadata
        return (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text bold>📄 Library Item</Text>
            </Box>

            <Box paddingLeft={2}>
              <Text>{JSON.stringify(selectedItem, null, 2)}</Text>
            </Box>
          </Box>
        );
      }

    case "generate":
      if (!selectedItem) {
        return (
          <Box>
            <Text color="yellow">No content generated</Text>
          </Box>
        );
      }

      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="green">✅ Report Generated</Text>
          </Box>

          {selectedItem.id && (
            <Box marginBottom={1}>
              <Text>
                <Text bold>Stored with ID:</Text> {selectedItem.id}
              </Text>
            </Box>
          )}

          <Box marginTop={1} marginBottom={1}>
            <Text bold>Generated Content:</Text>
          </Box>

          <Box paddingLeft={2} paddingY={1} borderStyle="single" borderColor="green">
            <Text>{selectedItem.content}</Text>
          </Box>
        </Box>
      );

    case "stats":
      if (!selectedItem) {
        return (
          <Box>
            <Text color="yellow">No stats available</Text>
          </Box>
        );
      }

      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>📊 Library Statistics</Text>
          </Box>

          <Box marginBottom={1}>
            <Text>
              <Text bold>Total Items:</Text> {selectedItem.total_items} |
              <Text bold>Total Size:</Text> {formatBytes(selectedItem.total_size_bytes)}
            </Text>
          </Box>

          <Box marginBottom={1}>
            <Text bold>By Type:</Text>
          </Box>

          {Object.entries(selectedItem.types || {}).map(([type, count]) => (
            <Box key={type} marginLeft={2}>
              <Text>• {type}: {count as number}</Text>
            </Box>
          ))}

          {selectedItem.recent_activity?.length > 0 && (
            <>
              <Box marginTop={1} marginBottom={1}>
                <Text bold>Recent Activity:</Text>
              </Box>

              {selectedItem.recent_activity.slice(0, 5).map((activity: any) => (
                <Box key={activity.date} marginLeft={2}>
                  <Text>{activity.date}: {activity.items_added} items added</Text>
                </Box>
              ))}
            </>
          )}
        </Box>
      );

    default:
      return (
        <Box>
          <Text color="red">Unknown subcommand: {subcommand}</Text>
        </Box>
      );
  }
};

export default LibraryCommand;
