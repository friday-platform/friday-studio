import React from "react";
import { Box, Text } from "ink";

interface TabProps {
  label: string;
  icon?: string;
  children: React.ReactNode;
}

export const Tab: React.FC<TabProps> = ({ children }) => {
  return <>{children}</>;
};

interface TabGroupProps {
  activeTab: number;
  onTabChange?: (index: number) => void;
  children: React.ReactElement<TabProps>[];
}

export const TabGroup: React.FC<TabGroupProps> = ({
  activeTab,
  children,
}) => {
  const tabs = React.Children.toArray(children) as React.ReactElement<TabProps>[];
  const activeTabContent = tabs[activeTab];

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Tab Headers */}
      <Box flexDirection="row" marginBottom={1}>
        {tabs.map((tab, index) => {
          const isActive = index === activeTab;
          return (
            <Box key={index} marginRight={2}>
              <Text
                bold={isActive}
                color={isActive ? "cyan" : "gray"}
              >
                {tab.props.icon && `${tab.props.icon} `}
                {tab.props.label}
                {isActive && " ▼"}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Tab Content */}
      <Box flexGrow={1} flexDirection="column">
        {activeTabContent}
      </Box>
    </Box>
  );
};
