import React, { createContext, useContext, useState } from "react";

interface AppContextType {
  isLeaderKeyActive: boolean;
  setLeaderKeyActive: (active: boolean) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

interface AppProviderProps {
  children: React.ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => {
  const [isLeaderKeyActive, setIsLeaderKeyActive] = useState(false);

  const setLeaderKeyActive = (active: boolean) => {
    setIsLeaderKeyActive(active);
  };

  return (
    <AppContext.Provider value={{ isLeaderKeyActive, setLeaderKeyActive }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useAppContext must be used within an AppProvider");
  }
  return context;
};
