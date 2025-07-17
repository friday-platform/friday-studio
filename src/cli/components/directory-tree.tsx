import React from "react";
import { Box, Text } from "ink";

interface DirectoryNode {
  name: string;
  type: "file" | "directory";
  active?: boolean;
  children?: DirectoryNode[];
}

interface DirectoryTreeProps {
  tree: DirectoryNode;
  showRoot?: boolean;
}

// Tree drawing characters
const TREE_CHARS = {
  BRANCH: "├─ ",
  LAST_BRANCH: "└─ ",
  VERTICAL: "│  ",
  EMPTY: "   ",
};

function renderTree(
  node: DirectoryNode,
  prefix: string = "",
  isLast: boolean = true,
  isRoot: boolean = true,
): React.ReactElement[] {
  const elements: React.ReactElement[] = [];

  // Add the current node
  if (isRoot) {
    elements.push(
      <Text key={`root`} bold={node.active} dimColor={!node.active}>
        {node.name}
      </Text>,
    );
  } else {
    const branch = isLast ? TREE_CHARS.LAST_BRANCH : TREE_CHARS.BRANCH;
    elements.push(
      <Box key={`${prefix}-${node.name}`}>
        <Text key={1}>{prefix + branch}</Text>
        <Text></Text>
        <Text
          key={2}
          bold={node.active}
          color={node.active ? "yellow" : undefined}
        >
          {node.name}
        </Text>
      </Box>,
    );
  }

  // Render children if it's a directory
  if (node.type === "directory" && node.children) {
    const childCount = node.children.length;
    node.children.forEach((child, index) => {
      const isLastChild = index === childCount - 1;
      const childPrefix = isRoot ? "" : prefix + (isLast ? TREE_CHARS.EMPTY : TREE_CHARS.VERTICAL);

      const childElements = renderTree(child, childPrefix, isLastChild, false);
      elements.push(...childElements);
    });
  }

  return elements;
}

export const DirectoryTree = ({
  tree,
  showRoot = true,
}: DirectoryTreeProps) => {
  const elements = renderTree(tree, "", true, showRoot);

  return <Box flexDirection="column">{elements}</Box>;
};
