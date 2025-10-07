import { useStdin } from "ink";
import { useEffect } from "react";

/**
 * Increases the max listeners limit for Ink's internal event emitter.
 *
 * This is NOT a memory leak fix, but rather a legitimate need to support
 * many interactive components. The Atlas CLI has numerous components that
 * need to listen for user input:
 * - CommandInput (main input)
 * - Multiple selection components (Workspace, Signal, Agent, Job, Session)
 * - View components (Config, Init, Help, Credits)
 * - Interactive elements (LogViewer, ErrorAlert, Collapsible)
 *
 * Each component uses Ink's useInput hook, which adds a listener to the
 * internal event emitter. With 15-20 interactive components, we exceed
 * the default limit of 10 listeners, which triggers a warning.
 *
 * This is expected behavior for a complex CLI with many interactive elements.
 */
export const MaxListenersFix = () => {
  const stdin = useStdin();

  useEffect(() => {
    // Access Ink's internal event emitter through stdin context
    const eventEmitter = stdin?.internal_eventEmitter;

    if (eventEmitter && typeof eventEmitter.setMaxListeners === "function") {
      // Increase limit to handle multiple interactive components
      eventEmitter.setMaxListeners(50);
    }
  }, [stdin]);

  return null;
};
