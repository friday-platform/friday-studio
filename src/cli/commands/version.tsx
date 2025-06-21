import { Text, Box } from "ink";
import { getVersionInfo } from "../../utils/version.ts";

interface VersionCommandProps {
  flags?: Record<string, unknown>;
}

export default function VersionCommand({ flags }: VersionCommandProps) {
  const versionInfo = getVersionInfo();
  
  // If --json flag is provided, output JSON
  if (flags?.json) {
    return <Text>{JSON.stringify(versionInfo, null, 2)}</Text>;
  }

  // Simple version output (default)
  return (
    <Box flexDirection="column">
      <Text color="cyan">Atlas {versionInfo.version}</Text>
      
      {versionInfo.isDev && (
        <Text color="yellow">
          Running from source {versionInfo.gitSha ? `(${versionInfo.gitSha})` : ""}
        </Text>
      )}
      
      {versionInfo.isNightly && (
        <Text color="magenta">
          Nightly build from commit {versionInfo.gitSha}
        </Text>
      )}
      
      {versionInfo.isCompiled && !versionInfo.isNightly && (
        <Text color="green">Release build</Text>
      )}
    </Box>
  );
}