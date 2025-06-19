// No React import needed with react-jsx
import { Box, Text } from "ink";

export interface Column {
  key: string;
  label: string;
  width?: number;
  align?: "left" | "right" | "center";
  color?: string;
}

export interface TableProps {
  columns: Column[];
  data: Record<string, string | number>[];
  borderColor?: string;
}

export function Table({ columns, data, borderColor = "gray" }: TableProps) {
  // Calculate column widths
  const columnWidths = columns.map((col) => {
    const maxDataWidth = Math.max(
      col.label.length,
      ...data.map((row) => String(row[col.key] || "").length),
    );
    return col.width || Math.min(maxDataWidth + 2, 40);
  });

  // Render header
  const renderHeader = () => (
    <Box>
      {columns.map((col, i) => (
        <Box key={col.key} width={columnWidths[i]} paddingRight={1}>
          <Text bold color="cyan">
            {col.align === "right"
              ? col.label.padStart(columnWidths[i] - 2)
              : col.align === "center"
              ? col.label.padStart((columnWidths[i] - 2 + col.label.length) / 2)
                .padEnd(columnWidths[i] - 2)
              : col.label.padEnd(columnWidths[i] - 2)}
          </Text>
        </Box>
      ))}
    </Box>
  );

  // Render row
  const renderRow = (row: Record<string, string | number>, rowIndex: number) => (
    <Box key={rowIndex}>
      {columns.map((col, i) => {
        const value = String(row[col.key] || "");
        const color = col.color ||
          (typeof row[col.key + "Color"] === "string" ? row[col.key + "Color"] : "white");

        return (
          <Box key={col.key} width={columnWidths[i]} paddingRight={1}>
            <Text color={color}>
              {col.align === "right"
                ? value.padStart(columnWidths[i] - 2)
                : col.align === "center"
                ? value.padStart((columnWidths[i] - 2 + value.length) / 2)
                  .padEnd(columnWidths[i] - 2)
                : value.padEnd(columnWidths[i] - 2)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  // Render separator
  const renderSeparator = () => {
    const line = columns.map((_, i) => "─".repeat(columnWidths[i] - 1)).join(
      "─",
    );
    return <Text color={borderColor}>{line}</Text>;
  };

  return (
    <Box flexDirection="column">
      {renderHeader()}
      {renderSeparator()}
      {data.map((row, i) => renderRow(row, i))}
    </Box>
  );
}
