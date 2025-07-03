import React, { createContext, useContext, useState } from "react";

interface AtlasConfig {
  apiKey: string;
  daemonPort: string;
  streamMessages: boolean;
}

interface AppContextType {
  isLeaderKeyActive: boolean;
  setLeaderKeyActive: (active: boolean) => void;
  config: AtlasConfig;
  updateConfig: (newConfig: AtlasConfig) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

interface AppProviderProps {
  children: React.ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => {
  const [isLeaderKeyActive, setIsLeaderKeyActive] = useState(false);
  const [config, setConfig] = useState<AtlasConfig>({
    apiKey: "",
    daemonPort: "8080",
    streamMessages: true,
  });

  const setLeaderKeyActive = (active: boolean) => {
    setIsLeaderKeyActive(active);
  };

  const updateConfig = (newConfig: AtlasConfig) => {
    setConfig(newConfig);
  };

  return (
    <AppContext.Provider
      value={{
        isLeaderKeyActive,
        setLeaderKeyActive,
        config,
        updateConfig,
      }}
    >
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
