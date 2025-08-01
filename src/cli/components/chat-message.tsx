import { Box } from "ink";
import { MarkdownDisplay } from "./markdown-display.tsx";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { useMarkdown } from "../modules/conversation/use-markdown.ts";
import { useCallback } from "react";
import { useAppContext } from "../contexts/app-context.tsx";

// Chat Message Component
interface ChatMessageProps {
  author?: string;
  authorColor?: string;
  date?: string;
  message?: string;
  children?: React.ReactNode;
  dimColor?: boolean;
  hideHeader?: boolean;
  showCollapsible?: boolean;
  fixedHeight?: boolean;
}

export const ChatMessage = ({
  message,
  children,
  dimColor = false,
  hideHeader = false,
  showCollapsible = false,
  fixedHeight = false,
}: ChatMessageProps) => {
  const { isCollapsed } = useAppContext();

  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  const { height, totalLines, markdown } = useMarkdown(message, dimColor);

  const calculateHeight = useCallback(() => {
    if (!fixedHeight) return undefined;

    if (showCollapsible && isCollapsed) {
      return Math.min(height, 10);
    }

    return height;
  }, [fixedHeight, height, hideHeader, showCollapsible]);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={calculateHeight()}
      overflowY="hidden"
      width={dimensions.paddedWidth}
    >
      <MarkdownDisplay
        markdown={markdown}
        totalLines={totalLines}
        showCollapsible={showCollapsible}
      />

      {children}
    </Box>
  );
};
