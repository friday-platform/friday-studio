import { useState } from "react";
import { useInput } from "ink";

export interface TabNavigationHookProps {
  tabCount: number;
  initialTab?: number;
  onTabChange?: (index: number) => void;
  useArrowKeys?: boolean;
  isActive?: boolean;
}

export interface ActiveFocusHookProps {
  areas: string[];
  initialArea?: number;
  onFocusChange?: (index: number) => void;
}

export const useTabNavigation = ({
  tabCount,
  initialTab = 0,
  onTabChange,
  useArrowKeys = false,
  isActive = true,
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

  // Handle arrow key navigation if enabled and active
  useInput((inputChar, key) => {
    if (useArrowKeys && isActive && tabCount > 0) {
      // Handle arrow keys and vim keys
      if (key.upArrow || inputChar === "k") {
        if (key.shift) {
          // Jump by 10 items backwards
          goToTab(Math.max(0, activeTab - 10));
        } else {
          previousTab();
        }
      } else if (key.downArrow || inputChar === "j") {
        if (key.shift) {
          // Jump by 10 items forwards
          goToTab(Math.min(tabCount - 1, activeTab + 10));
        } else {
          nextTab();
        }
      }

      // Handle vim keys with shift modifier separately since inputChar doesn't carry shift state
      if (inputChar === "K") {
        // Shift+k = fast backwards
        goToTab(Math.max(0, activeTab - 10));
      } else if (inputChar === "J") {
        // Shift+j = fast forwards
        goToTab(Math.min(tabCount - 1, activeTab + 10));
      }
    }
  });

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

export const useActiveFocus = ({
  areas,
  initialArea = 0,
  onFocusChange,
}: ActiveFocusHookProps) => {
  const [activeArea, setActiveArea] = useState(initialArea);

  const changeArea = (newArea: number) => {
    const clampedArea = Math.max(0, Math.min(areas.length - 1, newArea));
    setActiveArea(clampedArea);
    onFocusChange?.(clampedArea);
  };

  const nextArea = () => {
    changeArea((activeArea + 1) % areas.length);
  };

  const previousArea = () => {
    changeArea((activeArea - 1 + areas.length) % areas.length);
  };

  const goToArea = (index: number) => {
    changeArea(index);
  };

  // Handle left/right arrow keys and vim keys for focus navigation
  useInput((inputChar, key) => {
    if (areas.length > 1) {
      if (key.leftArrow || inputChar === "h" || inputChar === "H") {
        previousArea();
      } else if (key.rightArrow || inputChar === "l" || inputChar === "L") {
        nextArea();
      }
    }
  });

  return {
    activeArea,
    nextArea,
    previousArea,
    goToArea,
    changeArea,
  };
};
