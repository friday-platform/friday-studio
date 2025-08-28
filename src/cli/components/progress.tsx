import type { UIDataTypes, UIMessagePart, UITools } from "ai";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

interface Props {
  actions: UIMessagePart<UIDataTypes, UITools>[];
}

export const Progress = ({ actions }: Props) => {
  const [dots, setDots] = useState(".");

  const [time, setTime] = useState(0);
  const [progressActions, setProgressActions] = useState(
    actions.filter((action) => action.type === "data-tool-progress"),
  );
  const [staticActions, setStaticActions] = useState(
    actions.filter((action) => action.type !== "data-tool-progress" && action.type !== "reasoning"),
  );

  useEffect(() => {
    setProgressActions(actions.filter((action) => action.type === "data-tool-progress"));
    setStaticActions(
      actions.filter(
        (action) => action.type !== "data-tool-progress" && action.type !== "reasoning",
      ),
    );
  }, [actions]);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => {
        if (prev === ".") return "..";
        if (prev === "..") return "...";
        if (prev === "...") return "";
        return ".";
      });
    }, 500); // Change dots every 500ms

    return () => {
      clearInterval(interval);
      setProgressActions([]);
      setStaticActions([]);
    };
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    interval = setInterval(() => {
      setTime((prev) => prev + 1);
    }, 1000);

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, []);

  function getMessage(action: UIMessagePart<UIDataTypes, UITools>) {
    if (action?.type === "text") {
      return "Typing";
    } else if (action?.type === "step-start") {
      return "Processing";
    } else if (action?.type.startsWith("tool-")) {
      return "Calling Tools";
    } else {
      return null;
    }
  }

  return (
    <Box flexDirection="column">
      <Text bold>
        Thinking ({time}s){dots}
      </Text>

      {staticActions
        .map((action, index) => {
          const message = getMessage(action);

          if (message) {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: we have nothing else to define this by
              <Text key={index} dimColor bold>
                {index === staticActions.length - 1 && progressActions.length === 0 ? "└─" : "├─"}{" "}
                {message}
              </Text>
            );
          }

          return null;
        })
        .filter((action) => action !== null)}

      {progressActions.length > 0 && (
        <>
          <Text bold dimColor>
            ├─ Working...
          </Text>

          <Box flexDirection="column">
            {progressActions
              .map((action, index) => {
                if ("data" in action) {
                  if (
                    typeof action.data === "object" &&
                    action.data !== null &&
                    "content" in action.data &&
                    typeof action.data.content === "string"
                  ) {
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: we have nothing else to define this by
                      <Text key={index} dimColor bold>
                        {index === progressActions.length - 1 ? "└───" : "├───"}{" "}
                        {action.data.content}
                      </Text>
                    );
                  }
                }

                return null;
              })
              .filter((action) => action !== null)}
          </Box>
        </>
      )}
    </Box>
  );
};
