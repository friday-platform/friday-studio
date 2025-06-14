import React, { ReactNode, useState } from "react";
import { Box, Text } from "ink";

export interface TabProps {
  label: string;
  icon?: string;
  children: ReactNode;
  isActive?: boolean;
  onActivate?: () => void;
}

export interface TabGroupProps {
  children: React.ReactElement<TabProps> | React.ReactElement<TabProps>[];
  activeTab?: number;
  onTabChange?: (index: number) => void;
  showIndicators?: boolean;
}

export const Tab: React.FC<TabProps> = ({ children }: TabProps) => {
  return <>{children}</>;
};

export const TabGroup: React.FC<TabGroupProps> = ({
  children,
  activeTab = 0,
  onTabChange,

  showIndicators = true,
}: TabGroupProps) => {
  const [internalActiveTab, setInternalActiveTab] = useState(activeTab);

  const currentActiveTab = onTabChange ? activeTab : internalActiveTab;

  const handleTabChange = (index: number) => {
    if (onTabChange) {
      onTabChange(index);
    } else {
      setInternalActiveTab(index);
    }
  };

  const tabs = React.Children.toArray(children).filter(
    React.isValidElement,
  ) as React.ReactElement<TabProps>[];

  const renderTabHeaders = () => {
    // Horizontal orientation
    return (
      <Box flexDirection="row" padding={1}>
        {tabs.map((tab, index) => {
          const isActive = index === currentActiveTab && currentActiveTab >= 0;
          const shortcutText = isActive
            ? " (active)"
            : index < currentActiveTab
            ? " Alt+←"
            : " Alt+→";
          const width =
            `${tab.props.icon ? `${tab.props.icon} ` : ""}${tab.props.label}${shortcutText}`
              .length + 3;
          return (
            <Box
              key={index}
              flexDirection="column"
              padding={0}
              borderStyle={{
                topLeft: "",
                top: isActive && showIndicators ? "▔" : "",
                topRight: "",
                left: "",
                bottomLeft: "",
                bottom: "",
                bottomRight: "",
                right: "",
              }}
              width={width}
            >
              <Text>
                <Text bold={isActive} color={isActive ? "green" : "gray"}>
                  {tab.props.icon && `${tab.props.icon} `}
                  {tab.props.label || ""}
                </Text>
                <Text color="gray" dimColor>
                  {isActive ? " (active)" : index < currentActiveTab ? " Alt+←" : " Alt+→"}
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  };

  const renderTabContent = () => {
    // Handle case where no tab is selected (activeTab = -1) or out of bounds
    if (currentActiveTab < 0 || currentActiveTab >= tabs.length) {
      return <Box flexGrow={1} flexDirection="column" />;
    }

    const activeTabContent = tabs[currentActiveTab];
    if (!activeTabContent) return null;

    return (
      <Box flexGrow={1} flexDirection="column">
        {activeTabContent.props.children}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" height="100%">
      {renderTabHeaders()}
      <Box flexGrow={1} borderTop borderColor="gray">
        {renderTabContent()}
      </Box>
    </Box>
  );
};

export interface TabNavigationHookProps {
  tabCount: number;
  initialTab?: number;
  onTabChange?: (index: number) => void;
}

export const useTabNavigation = ({
  tabCount,
  initialTab = 0,
  onTabChange,
}: TabNavigationHookProps) => {
  const [activeTab, setActiveTab] = useState(initialTab);

  const changeTab = (newTab: number) => {
    const clampedTab = Math.max(0, Math.min(tabCount - 1, newTab));
    setActiveTab(clampedTab);
    onTabChange?.(clampedTab);
  };

  const nextTab = () => {
    changeTab((activeTab + 1) % tabCount);
  };

  const previousTab = () => {
    changeTab((activeTab - 1 + tabCount) % tabCount);
  };

  const goToTab = (index: number) => {
    changeTab(index);
  };

  const goToFirstTab = () => {
    changeTab(0);
  };

  const goToLastTab = () => {
    changeTab(tabCount - 1);
  };

  return {
    activeTab,
    nextTab,
    previousTab,
    goToTab,
    goToFirstTab,
    goToLastTab,
    changeTab,
  };
};
