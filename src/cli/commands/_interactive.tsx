import { useState } from "react";
import { ResponsiveContainer } from "../components/ResponsiveContainer.tsx";
import { SplashScreen } from "../components/SplashScreen.tsx";
import { WorkspaceView } from "../components/WorkspaceView.tsx";
import { Box, Text, useStdout } from "ink";

type ViewMode = "splash" | "workspace";

interface Workspace {
  id: string;
  name: string;
  path: string;
  slug?: string;
}

export default function InteractiveCommand() {
  const [viewMode, setViewMode] = useState<ViewMode>("splash");
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = useState<
    string | null
  >(null);
  const [minHeight, setMinHeight] = useState(35);

  const handleWorkspaceSelect = (workspace: Workspace) => {
    // Extract slug from path or use a default based on workspace name
    const slug = workspace.slug ||
      workspace.path.split("/").pop() ||
      workspace.name.toLowerCase().replace(/\s+/g, "-");
    setSelectedWorkspaceSlug(slug);
    setViewMode("workspace");
    setMinHeight(35); // Reset to simple minimum for workspace view
  };

  const handleBackToSplash = () => {
    setSelectedWorkspaceSlug(null);
    setViewMode("splash");
  };

  const handleMinHeightChange = (height: number) => {
    setMinHeight(height);
  };

  return (
    <ResponsiveContainer minHeight={minHeight}>
      {viewMode === "splash" && (
        <SplashScreen
          onWorkspaceSelect={handleWorkspaceSelect}
          onMinHeightChange={handleMinHeightChange}
        />
      )}
      {viewMode === "workspace" && selectedWorkspaceSlug && (
        <WorkspaceView
          workspaceSlug={selectedWorkspaceSlug}
          onBack={handleBackToSplash}
        />
      )}
    </ResponsiveContainer>
  );
}