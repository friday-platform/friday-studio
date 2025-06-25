/**
 * Integration Example: Atlas Supervisor Hallucination Testing
 * 
 * Demonstrates how to run the hallucination test framework with the
 * existing Atlas test infrastructure. This provides a working example
 * of the complete testing pipeline.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { 
  HallucinationTestRunner,
  TestSuite,
  TestRunResults
} from "./framework/test-runner.ts";
import { workspaceSupervisorSignalAnalysisTests } from "./scenarios/workspace-supervisor/signal-analysis-test.ts";

/**
 * Example test integration showing complete hallucination testing workflow
 */
Deno.test("Atlas Supervisor Hallucination Testing - Integration Example", async () => {
  console.log("🧠 Starting Atlas Supervisor Hallucination Testing...");
  
  // Create test runner with configuration
  const testRunner = new HallucinationTestRunner({
    maxConcurrency: 2, // Limit concurrency for test stability
    timeoutMs: 30000, // 30 second timeout
    enableDetailedReporting: true,
    enableProgressReporting: true,
    outputFormat: 'text',
    outputPath: './test-results'
  });
  
  // Add progress callback for real-time updates
  testRunner.setProgressCallback((progress) => {
    console.log(`📊 Progress: ${progress.phase} - ${progress.completedTests}/${progress.totalTests} tests`);
    if (progress.currentTest) {
      console.log(`🔍 Running: ${progress.currentTest}`);
    }
  });
  
  // Register test suites
  const workspaceSupervisorSuite: TestSuite = {
    name: "WorkspaceSupervisor Signal Analysis",
    description: "Tests for hallucinations in WorkspaceSupervisor signal analysis decisions",
    tests: workspaceSupervisorSignalAnalysisTests,
    
    setup: async () => {
      console.log("🏗️  Setting up WorkspaceSupervisor test suite...");
      // Initialize any required test infrastructure
      // In real implementation, would set up mock supervisors, test data, etc.
    },
    
    teardown: async () => {
      console.log("🧹 Cleaning up WorkspaceSupervisor test suite...");
      // Clean up test resources
    }
  };
  
  testRunner.addTestSuite(workspaceSupervisorSuite);
  
  // Run all tests
  const startTime = Date.now();
  const results: TestRunResults = await testRunner.runAllTests();
  const totalTime = Date.now() - startTime;
  
  // Assert basic test execution
  assertExists(results);
  assertExists(results.summary);
  assertEquals(results.suiteResults.length, 1);
  
  // Log comprehensive results
  console.log("\n" + "=".repeat(80));
  console.log("🧠 ATLAS SUPERVISOR HALLUCINATION TEST RESULTS");
  console.log("=".repeat(80));
  console.log(`⏱️  Total Execution Time: ${totalTime}ms`);
  console.log(`📊 Total Tests: ${results.summary.totalTests}`);
  console.log(`✅ Passed: ${results.summary.totalPassed}`);
  console.log(`❌ Failed: ${results.summary.totalFailed}`);
  console.log(`🔍 Hallucinations Detected: ${results.summary.totalHallucinationsDetected}`);
  console.log(`🚨 Critical Hallucinations: ${results.summary.criticalHallucinations}`);
  console.log(`⚠️  High Severity Hallucinations: ${results.summary.highSeverityHallucinations}`);
  
  console.log("\n📈 METRICS SUMMARY:");
  console.log(`Accuracy Score: ${results.summary.averageAccuracyScore}/100`);
  console.log(`Safety Score: ${results.summary.averageSafetyScore}/100`);
  console.log(`Context Adherence: ${results.summary.averageContextAdherenceScore}/100`);
  console.log(`Overall Hallucination Risk: ${results.summary.overallHallucinationRisk}/100`);
  
  // Risk assessment
  const riskLevel = getRiskLevel(results.summary.overallHallucinationRisk);
  console.log(`\n🎯 RISK ASSESSMENT: ${riskLevel.emoji} ${riskLevel.level} - ${riskLevel.description}`);
  
  // Detailed test results
  console.log("\n📋 DETAILED TEST RESULTS:");
  for (const suiteResult of results.suiteResults) {
    console.log(`\n📁 Suite: ${suiteResult.suiteName}`);
    console.log(`   Tests: ${suiteResult.testResults.length}`);
    console.log(`   Passed: ${suiteResult.passed}`);
    console.log(`   Failed: ${suiteResult.failed}`);
    console.log(`   Execution Time: ${suiteResult.executionTimeMs}ms`);
    
    // Show individual test results
    for (const testResult of suiteResult.testResults) {
      const status = testResult.success ? "✅" : "❌";
      const hallucinationFlag = testResult.hallucinationDetected ? "🧠" : "";
      console.log(`   ${status} ${hallucinationFlag} ${testResult.testId} (${testResult.executionTime}ms)`);
      
      if (testResult.detectedHallucinations.length > 0) {
        console.log(`      🔍 Hallucinations detected: ${testResult.detectedHallucinations.length}`);
        for (const hallucination of testResult.detectedHallucinations) {
          const severityIcon = getSeverityIcon(hallucination.severity);
          console.log(`         ${severityIcon} ${hallucination.description}`);
        }
      }
      
      if (testResult.errors.length > 0) {
        console.log(`      ❗ Errors: ${testResult.errors.join(", ")}`);
      }
    }
  }
  
  // Validate test quality
  console.log("\n🔬 TEST QUALITY VALIDATION:");
  
  // Check that tests actually detected hallucinations where expected
  const testsWithHallucinations = results.suiteResults
    .flatMap(s => s.testResults)
    .filter(t => t.hallucinationDetected);
  
  console.log(`Tests detecting hallucinations: ${testsWithHallucinations.length}`);
  
  if (testsWithHallucinations.length > 0) {
    console.log("✅ Hallucination detection system is working");
  } else {
    console.log("⚠️  No hallucinations detected - verify test scenarios");
  }
  
  // Check for any critical failures
  const criticalFailures = results.suiteResults
    .flatMap(s => s.testResults)
    .flatMap(t => t.detectedHallucinations)
    .filter(h => h.severity === 'critical');
  
  if (criticalFailures.length > 0) {
    console.log(`🚨 ${criticalFailures.length} critical hallucinations detected:`);
    for (const failure of criticalFailures) {
      console.log(`   - ${failure.description}`);
    }
  }
  
  // Performance assessment
  const avgTestTime = totalTime / results.summary.totalTests;
  console.log(`\n⚡ PERFORMANCE METRICS:`);
  console.log(`Average test execution time: ${avgTestTime.toFixed(1)}ms`);
  console.log(`Tests per second: ${(1000 / avgTestTime).toFixed(2)}`);
  
  if (avgTestTime > 5000) {
    console.log("⚠️  Tests are running slowly - consider optimization");
  } else {
    console.log("✅ Test performance is acceptable");
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("🎉 Hallucination testing completed successfully!");
  console.log("=".repeat(80));
  
  // Basic assertions to ensure test framework is working
  assertEquals(typeof results.summary.totalTests, "number");
  assertEquals(typeof results.summary.overallHallucinationRisk, "number");
  
  // Ensure we have meaningful test coverage
  if (results.summary.totalTests < 3) {
    throw new Error("Insufficient test coverage - need at least 3 tests");
  }
  
  // Ensure hallucination detection is functioning
  if (results.summary.totalHallucinationsDetected === 0) {
    console.warn("⚠️  No hallucinations detected - may indicate test scenario issues");
  }
});

/**
 * Utility function to determine risk level from score
 */
function getRiskLevel(riskScore: number): { level: string; emoji: string; description: string } {
  if (riskScore >= 80) {
    return {
      level: "CRITICAL",
      emoji: "🔴",
      description: "Immediate attention required. Multiple severe hallucinations detected."
    };
  } else if (riskScore >= 60) {
    return {
      level: "HIGH", 
      emoji: "🟠",
      description: "Review and fix detected issues before production deployment."
    };
  } else if (riskScore >= 30) {
    return {
      level: "MEDIUM",
      emoji: "🟡", 
      description: "Some issues detected. Consider improvements."
    };
  } else {
    return {
      level: "LOW",
      emoji: "🟢",
      description: "Supervisor decisions appear reliable."
    };
  }
}

/**
 * Utility function to get emoji for hallucination severity
 */
function getSeverityIcon(severity: string): string {
  switch (severity) {
    case 'critical': return '🔴';
    case 'high': return '🟠'; 
    case 'medium': return '🟡';
    case 'low': return '🔵';
    default: return '⚪';
  }
}

/**
 * Example of running specific test category
 */
Deno.test("Atlas Hallucination Testing - Factual Accuracy Only", async () => {
  console.log("🔍 Testing factual accuracy hallucinations only...");
  
  const testRunner = new HallucinationTestRunner({
    maxConcurrency: 1,
    timeoutMs: 15000,
    enableDetailedReporting: false
  });
  
  // Filter tests to only include factual accuracy tests
  const factualAccuracyTests = workspaceSupervisorSignalAnalysisTests.filter(
    test => test.category.toString() === "factual_accuracy"
  );
  
  const factualSuite: TestSuite = {
    name: "Factual Accuracy Tests",
    description: "Tests specifically for factual accuracy hallucinations",
    tests: factualAccuracyTests
  };
  
  testRunner.addTestSuite(factualSuite);
  const results = await testRunner.runAllTests();
  
  console.log(`✅ Factual accuracy tests completed: ${results.summary.totalPassed}/${results.summary.totalTests} passed`);
  
  // Ensure we have factual accuracy tests
  assertEquals(results.summary.totalTests > 0, true, "Should have factual accuracy tests");
});

/**
 * Example of custom test configuration
 */
Deno.test("Atlas Hallucination Testing - Custom Configuration", async () => {
  console.log("⚙️  Testing with custom configuration...");
  
  // High-performance configuration for CI/CD
  const testRunner = new HallucinationTestRunner({
    maxConcurrency: 4, // Higher concurrency for faster execution
    timeoutMs: 10000, // Shorter timeout for faster feedback
    enableDetailedReporting: false, // Disable for speed
    enableProgressReporting: false, // Disable for cleaner CI logs
    outputFormat: 'json' // Machine-readable output for CI
  });
  
  const quickSuite: TestSuite = {
    name: "Quick Validation Suite",
    description: "Fast validation of critical hallucination detection",
    tests: workspaceSupervisorSignalAnalysisTests.slice(0, 2) // Only first 2 tests for speed
  };
  
  testRunner.addTestSuite(quickSuite);
  const results = await testRunner.runAllTests();
  
  // Validate CI-friendly results
  assertExists(results.summary);
  console.log(`⚡ Quick validation completed in ${results.executionTimeMs}ms`);
  
  // Ensure reasonable performance for CI
  const avgTimePerTest = results.executionTimeMs / results.summary.totalTests;
  if (avgTimePerTest > 3000) {
    console.warn(`⚠️  Average test time ${avgTimePerTest}ms may be too slow for CI`);
  }
});