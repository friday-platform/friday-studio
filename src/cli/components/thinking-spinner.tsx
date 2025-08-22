import { useEffect, useState } from "react";
import { Text } from "ink";

interface ThinkingSpinnerProps {
  elapsedSeconds: number;
}

export const ThinkingSpinner = ({ elapsedSeconds }: ThinkingSpinnerProps) => {
  const [dots, setDots] = useState(".");

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => {
        if (prev === ".") return "..";
        if (prev === "..") return "...";
        if (prev === "...") return "";
        return ".";
      });
    }, 500); // Change dots every 500ms

    return () => clearInterval(interval);
  }, []);

  return (
    <Text>
      Thinking ({elapsedSeconds}s){dots}
    </Text>
  );
};
