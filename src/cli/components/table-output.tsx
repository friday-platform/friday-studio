import { Box, Text } from "ink";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";

export function TableOutput({
  data,
}: {
  data: { data: { headers: string[]; rows: Record<string, string | number>[] } };
}) {
  if (!data) return null;

  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  function getMaxColumnWidth(header: string) {
    let maxLen = header.length;
    for (const row of data.data.rows) {
      const value = row[header];
      const strValue = value !== undefined && value !== null ? String(value) : "";
      if (strValue.length > maxLen) {
        maxLen = strValue.length;
      }
    }
    return maxLen + 1;
  }

  return (
    <Box flexDirection="column" width={dimensions.paddedWidth}>
      <Box flexDirection="row" flexGrow={1} width="100%">
        {data.data.headers.map((header) => {
          const width = getMaxColumnWidth(header);
          return (
            <Box key={`${header}-top`} width={width} flexShrink={0} flexDirection="column">
              <Text>{"-".repeat(width)}</Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="row" flexGrow={1} width="100%">
        {data.data.headers.map((header) => {
          const width = getMaxColumnWidth(header);
          return (
            <Box key={header} width={width} flexShrink={0} flexDirection="column">
              <Text>{header}</Text>
              <Text>{"-".repeat(width)}</Text>
            </Box>
          );
        })}
      </Box>

      {data.data.rows.map((row) => (
        <Box key={row.id} flexDirection="row" flexGrow={1} width="100%">
          {data.data.headers.map((header) => {
            const width = getMaxColumnWidth(header);

            return (
              <Box key={`${row.id}-${header}`} width={width} flexShrink={0} flexDirection="column">
                <Text>{row[header]}</Text>
                <Text>{"-".repeat(width)}</Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
