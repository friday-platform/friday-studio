import { Box, Newline, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { WorkspaceSelection } from "./workspace-selection.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { getDaemonClient } from "../../utils/daemon-client.ts";
import { fetchLibraryItems } from "../library/fetcher.ts";
import { LibraryListComponent } from "../library/library-list-component.tsx";
import { OutputEntry } from "./index.ts";

interface LibraryCommandProps {
  onComplete: () => void;
}

export function LibraryCommand({ onComplete }: LibraryCommandProps) {
  const { setOutputBuffer } = useAppContext();

  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  const getWorkspaceById = async (workspaceId: string) => {
    try {
      const client = getDaemonClient();
      return await client.getWorkspace(workspaceId);
    } catch {
      return null;
    }
  };

  const handleWorkspaceSelect = async (workspaceId: string) => {
    // Add loading entry
    addOutputEntry({
      id: `loading-${Date.now()}`,
      component: (
        <Box>
          <Spinner label="Loading library items..." />
        </Box>
      ),
    });

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      const result = await fetchLibraryItems({
        workspace: workspace.path,
        port: 8080,
      });

      // Remove loading entry
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `spacer-${Date.now()}-1`,
        component: <Newline />,
      });

      if (!result.success) {
        // Show non-error message for API failures
        const errorResult = result as { error: string };
        addOutputEntry({
          id: `library-unavailable-${Date.now()}`,
          component: (
            <Text dimColor>
              Cannot fetch library items: {errorResult.error}
            </Text>
          ),
        });
      } else {
        addOutputEntry({
          id: `library-table-${Date.now()}`,
          component: (
            <LibraryListComponent
              items={result.items}
              workspaceName={workspace.name}
            />
          ),
        });
      }
    } catch (error) {
      // Remove loading entry and add error
      setOutputBuffer((prev) => prev.slice(0, -1)); // Remove last entry (loading)

      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text dimColor>
            Cannot fetch library items: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    }

    onComplete();
  };

  return (
    <WorkspaceSelection
      onEscape={onComplete}
      onWorkspaceSelect={handleWorkspaceSelect}
    />
  );
}
