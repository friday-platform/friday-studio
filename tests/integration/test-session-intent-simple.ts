#!/usr/bin/env -S deno run --allow-env --allow-read --no-check

// Simple test for session intent flow without type checking
import { Session, SessionIntent } from "../../src/core/session.ts";
import { WorkspaceSupervisor } from "../../src/core/supervisor.ts";

console.log("🧪 Testing Session Intent Flow...\n");

// Test 1: Session creation with intent
console.log("Test 1: Session creation with intent");
try {
  const intent: SessionIntent = {
    id: "test-intent-1",
    signal: {
      type: "test",
      data: { message: "Hello, World!" },
      metadata: { source: "test" }
    },
    goals: [
      "Process the test message",
      "Transform the message",
      "Return the result"
    ],
    constraints: {
      timeLimit: 5000,
    },
    executionHints: {
      strategy: 'iterative',
      maxIterations: 2
    }
  };

  const mockSignal = {
    id: "test-signal",
    provider: { name: "test-provider" },
    trigger: async () => {
      console.log("  Signal triggered");
    }
  } as any; // Type assertion to bypass strict typing

  const session = new Session(
    "test-workspace",
    {
      triggers: [mockSignal],
      callback: async (result: any) => {
        console.log("  Session callback received:", result);
      }
    },
    undefined,
    undefined,
    undefined,
    intent
  );

  console.log("  ✓ Session created with intent ID:", session.intent?.id);
  console.log("  ✓ Goals:", session.intent?.goals.length, "goals defined");
  console.log("  ✓ Max iterations:", session.intent?.executionHints?.maxIterations);
} catch (error) {
  console.error("  ✗ Error:", error.message);
}

// Test 2: Session FSM lifecycle
console.log("\nTest 2: Session FSM lifecycle");
try {
  const intent: SessionIntent = {
    id: "test-intent-fsm",
    signal: {
      type: "test",
      data: { value: 42 }
    },
    goals: ["Test FSM transitions"],
    executionHints: {
      strategy: 'iterative',
      maxIterations: 1
    }
  };

  const mockSignal = {
    id: "test-signal",
    provider: { name: "test-provider" },
    trigger: async () => {}
  } as any;

  const session = new Session(
    "test-workspace",
    {
      triggers: [mockSignal],
      callback: async (result: any) => {
        console.log("  Session completed");
      }
    },
    undefined,
    undefined,
    undefined,
    intent
  );

  const states: string[] = [];
  
  // Monitor state changes
  const checkStates = () => {
    const currentState = session.getCurrentState();
    if (!states.includes(currentState)) {
      states.push(currentState);
      console.log(`  → State: ${currentState}`);
    }
  };

  // Start monitoring
  const interval = setInterval(checkStates, 50);
  
  // Start the session
  session.start().then(() => {
    setTimeout(() => {
      clearInterval(interval);
      console.log("  ✓ States traversed:", states.join(" → "));
      console.log("  ✓ Session completed with status:", session.status);
      
      // Test 3: WorkspaceSupervisor intent creation
      console.log("\nTest 3: WorkspaceSupervisor intent creation");
      testSupervisor();
    }, 1500);
  });

} catch (error) {
  console.error("  ✗ Error:", error.message);
}

function testSupervisor() {
  try {
    const supervisor = new WorkspaceSupervisor("test-workspace", {
      model: "claude-3-5-sonnet-20241022"
    });

    const payload = { message: "Test message for telephone game" };
    const telephoneSignal = {
      id: "telephone-message",
      provider: { name: "test" },
      trigger: async () => {}
    } as any;

    const intent = supervisor.createSessionIntent(telephoneSignal, payload);

    console.log("  ✓ Intent created with type:", intent.signal.type);
    console.log("  ✓ Goals generated:", intent.goals.length, "goals");
    console.log("  ✓ Strategy:", intent.executionHints?.strategy);
    console.log("  ✓ First goal:", intent.goals[0]);
    
    supervisor.destroy();
    
    console.log("\n✅ All tests completed!");
  } catch (error) {
    console.error("  ✗ Error:", error.message);
  }
}