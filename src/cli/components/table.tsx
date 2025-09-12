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

function getColumnWidth(col: Column, data: Record<string, string | number>[]) {
  const maxDataWidth = Math.max(
    col.label.length,
    ...data.map((row) => String(row[col.key] || "").length),
  );
  return col.width || Math.min(maxDataWidth + 2, 40);
}

export function Table({ columns, data, borderColor = "gray" }: TableProps) {
  // Render header
  const renderHeader = () => (
    <Box>
      {columns.map((col) => {
        const width = getColumnWidth(col, data);

        return (
          <Box key={col.key} width={width} paddingRight={1}>
            <Text bold color="cyan">
              {col.align === "right"
                ? col.label.padStart(width - 2)
                : col.align === "center"
                  ? col.label.padStart((width - 2 + col.label.length) / 2).padEnd(width - 2)
                  : col.label.padEnd(width - 2)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  // Render row
  const renderRow = (row: Record<string, string | number>, rowIndex: number) => (
    <Box key={rowIndex}>
      {columns.map((col) => {
        const width = getColumnWidth(col, data);
        const value = String(row[col.key] || "");
        const color =
          col.color ||
          (typeof row[col.key + "Color"] === "string" ? row[col.key + "Color"] : "white");

        return (
          <Box key={col.key} width={width} paddingRight={1}>
            <Text color={color}>
              {col.align === "right"
                ? value.padStart(width - 2)
                : col.align === "center"
                  ? value.padStart((width - 2 + value.length) / 2).padEnd(width - 2)
                  : value.padEnd(width - 2)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  // Render separator
  const renderSeparator = () => {
    const line = columns.map((col) => "─".repeat(getColumnWidth(col, data) - 1)).join("─");
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
