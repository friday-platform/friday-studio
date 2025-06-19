import { useState } from "react";

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
