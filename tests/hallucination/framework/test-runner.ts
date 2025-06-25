/**
 * Hallucination Test Runner
 * 
 * Orchestrates execution of hallucination tests with parallel processing,
 * comprehensive reporting, and integration with existing Atlas test infrastructure.
 */

import { 
  BaseSupervisorHallucinationTest, 
  TestResult, 
  TestExecutionContext,
  TestCategory,
  SupervisorType,
  DecisionPoint
} from "./base-test.ts";

export interface TestRunnerConfig {
  maxConcurrency?: number;
  timeoutMs?: number;
  enableDetailedReporting?: boolean;
  enableMetricsCollection?: boolean;
  enableProgressReporting?: boolean;
  outputFormat?: 'text' | 'json' | 'html';
  outputPath?: string;
}

export interface TestSuite {
  name: string;
  description: string;
  tests: BaseSupervisorHallucinationTest[];
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
}

export interface TestRunResults {
  suiteResults: TestSuiteResult[];
  summary: TestRunSummary;
  executionTimeMs: number;
  timestamp: Date;
}

export interface TestSuiteResult {
  suiteName: string;
  testResults: TestResult[];
  passed: number;
  failed: number;
  hallucinationsDetected: number;
  executionTimeMs: number;
}

export interface TestRunSummary {
  totalTests: number;
  totalPassed: number;
  totalFailed: number;
  totalHallucinationsDetected: number;
  criticalHallucinations: number;
  highSeverityHallucinations: number;
  averageAccuracyScore: number;
  averageSafetyScore: number;
  averageContextAdherenceScore: number;
  overallHallucinationRisk: number;
  byCategory: Record<TestCategory, CategorySummary>;
  bySupervisorType: Record<SupervisorType, SupervisorTypeSummary>;
  byDecisionPoint: Record<DecisionPoint, DecisionPointSummary>;
}

export interface CategorySummary {
  totalTests: number;
  passed: number;
  failed: number;
  averageScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface SupervisorTypeSummary {
  totalTests: number;
  passed: number;
  failed: number;
  averageAccuracyScore: number;
  hallucinationCount: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface DecisionPointSummary {
  totalTests: number;
  passed: number;
  failed: number;
  hallucinationCount: number;
  averageRiskScore: number;
  criticalIssues: string[];
}

/**
 * Main test runner for Atlas supervisor hallucination tests
 */
export class HallucinationTestRunner {
  private config: Required<TestRunnerConfig>;
  private testSuites: TestSuite[] = [];
  private progressCallback?: (progress: TestProgress) => void;
  
  constructor(config: TestRunnerConfig = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 4,
      timeoutMs: config.timeoutMs ?? 60000, // 60 second timeout per test
      enableDetailedReporting: config.enableDetailedReporting ?? true,
      enableMetricsCollection: config.enableMetricsCollection ?? true,
      enableProgressReporting: config.enableProgressReporting ?? true,
      outputFormat: config.outputFormat ?? 'text',
      outputPath: config.outputPath ?? './test-results'
    };
  }
  
  /**
   * Register a test suite for execution
   */
  addTestSuite(suite: TestSuite): void {
    this.testSuites.push(suite);
  }
  
  /**
   * Set progress callback for real-time updates
   */
  setProgressCallback(callback: (progress: TestProgress) => void): void {
    this.progressCallback = callback;
  }
  
  /**
   * Execute all registered test suites
   */
  async runAllTests(): Promise<TestRunResults> {
    const startTime = Date.now();
    const timestamp = new Date();
    
    this.reportProgress({
      phase: 'initialization',
      totalSuites: this.testSuites.length,
      completedSuites: 0,
      totalTests: this.getTotalTestCount(),
      completedTests: 0,
      currentSuite: null,
      currentTest: null
    });
    
    const suiteResults: TestSuiteResult[] = [];
    
    for (let i = 0; i < this.testSuites.length; i++) {
      const suite = this.testSuites[i];
      
      this.reportProgress({
        phase: 'execution',
        totalSuites: this.testSuites.length,
        completedSuites: i,
        totalTests: this.getTotalTestCount(),
        completedTests: suiteResults.reduce((sum, r) => sum + r.testResults.length, 0),
        currentSuite: suite.name,
        currentTest: null
      });
      
      const suiteResult = await this.runTestSuite(suite);
      suiteResults.push(suiteResult);
    }
    
    const executionTimeMs = Date.now() - startTime;
    const summary = this.generateSummary(suiteResults);
    
    this.reportProgress({
      phase: 'completion',
      totalSuites: this.testSuites.length,
      completedSuites: this.testSuites.length,
      totalTests: this.getTotalTestCount(),
      completedTests: this.getTotalTestCount(),
      currentSuite: null,
      currentTest: null
    });
    
    const results: TestRunResults = {
      suiteResults,
      summary,
      executionTimeMs,
      timestamp
    };
    
    // Generate reports if enabled
    if (this.config.enableDetailedReporting) {
      await this.generateReport(results);
    }
    
    return results;
  }
  
  /**
   * Run a single test suite
   */
  async runTestSuite(suite: TestSuite): Promise<TestSuiteResult> {
    const startTime = Date.now();
    
    try {
      // Setup suite
      if (suite.setup) {
        await suite.setup();
      }
      
      // Execute tests with concurrency control
      const testResults = await this.executeTestsConcurrently(suite.tests, suite.name);
      
      // Teardown suite
      if (suite.teardown) {
        await suite.teardown();
      }
      
      const executionTimeMs = Date.now() - startTime;
      
      return {
        suiteName: suite.name,
        testResults,
        passed: testResults.filter(r => r.success).length,
        failed: testResults.filter(r => !r.success).length,
        hallucinationsDetected: testResults.filter(r => r.hallucinationDetected).length,
        executionTimeMs
      };
      
    } catch (error) {
      console.error(`Failed to run test suite ${suite.name}:`, error);
      
      return {
        suiteName: suite.name,
        testResults: [],
        passed: 0,
        failed: 1,
        hallucinationsDetected: 0,
        executionTimeMs: Date.now() - startTime
      };
    }
  }
  
  /**
   * Execute tests with controlled concurrency
   */
  private async executeTestsConcurrently(
    tests: BaseSupervisorHallucinationTest[], 
    suiteName: string
  ): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const semaphore = new Semaphore(this.config.maxConcurrency);
    
    const executeTest = async (test: BaseSupervisorHallucinationTest): Promise<TestResult> => {
      return semaphore.acquire(async () => {
        this.reportProgress({
          phase: 'execution',
          totalSuites: this.testSuites.length,
          completedSuites: 0, // Will be updated by caller
          totalTests: this.getTotalTestCount(),
          completedTests: results.length,
          currentSuite: suiteName,
          currentTest: test.testId
        });
        
        return this.executeTestWithTimeout(test);
      });
    };
    
    // Execute all tests concurrently
    const promises = tests.map(executeTest);
    const testResults = await Promise.all(promises);
    
    return testResults;
  }
  
  /**
   * Execute a single test with timeout protection
   */
  private async executeTestWithTimeout(test: BaseSupervisorHallucinationTest): Promise<TestResult> {
    const startTime = Date.now();
    
    try {
      // Create execution context (this would need to be provided by caller or mock)
      const context: TestExecutionContext = {
        supervisor: null, // Would be provided by test infrastructure
        testData: test['scenario'], // Access protected property
        canaryTraps: test['scenario'].canaryTraps || [],
        detectors: test['detectors'],
        metadata: { testId: test.testId, startTime }
      };
      
      // Execute test with timeout
      const timeoutPromise = new Promise<TestResult>((_, reject) => {
        setTimeout(() => reject(new Error('Test timeout')), this.config.timeoutMs);
      });
      
      const result = await Promise.race([
        test.execute(context),
        timeoutPromise
      ]);
      
      return result;
      
    } catch (error) {
      return {
        testId: test.testId,
        success: false,
        hallucinationDetected: false,
        detectedHallucinations: [],
        actualBehavior: null,
        metrics: {
          accuracyScore: 0,
          contextAdherenceScore: 0,
          consistencyScore: 0,
          safetyScore: 0,
          capabilityScore: 0,
          overallHallucinationRisk: 100
        },
        executionTime: Date.now() - startTime,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: []
      };
    }
  }
  
  /**
   * Generate comprehensive test run summary
   */
  private generateSummary(suiteResults: TestSuiteResult[]): TestRunSummary {
    const allTestResults = suiteResults.flatMap(s => s.testResults);
    const allHallucinations = allTestResults.flatMap(r => r.detectedHallucinations);
    
    const totalTests = allTestResults.length;
    const totalPassed = allTestResults.filter(r => r.success).length;
    const totalFailed = totalTests - totalPassed;
    const totalHallucinationsDetected = allTestResults.filter(r => r.hallucinationDetected).length;
    
    const criticalHallucinations = allHallucinations.filter(h => h.severity === 'critical').length;
    const highSeverityHallucinations = allHallucinations.filter(h => h.severity === 'high').length;
    
    // Calculate average scores
    const averageAccuracyScore = this.calculateAverageScore(allTestResults, 'accuracyScore');
    const averageSafetyScore = this.calculateAverageScore(allTestResults, 'safetyScore');
    const averageContextAdherenceScore = this.calculateAverageScore(allTestResults, 'contextAdherenceScore');
    const overallHallucinationRisk = this.calculateAverageScore(allTestResults, 'overallHallucinationRisk');
    
    // Generate category summaries
    const byCategory = this.generateCategorySummaries(allTestResults);
    const bySupervisorType = this.generateSupervisorTypeSummaries(allTestResults);
    const byDecisionPoint = this.generateDecisionPointSummaries(allTestResults);
    
    return {
      totalTests,
      totalPassed,
      totalFailed,
      totalHallucinationsDetected,
      criticalHallucinations,
      highSeverityHallucinations,
      averageAccuracyScore,
      averageSafetyScore,
      averageContextAdherenceScore,
      overallHallucinationRisk,
      byCategory,
      bySupervisorType,
      byDecisionPoint
    };
  }
  
  private calculateAverageScore(results: TestResult[], metric: keyof TestResult['metrics']): number {
    if (results.length === 0) return 0;
    
    const sum = results.reduce((acc, r) => acc + r.metrics[metric], 0);
    return Math.round(sum / results.length);
  }
  
  private generateCategorySummaries(results: TestResult[]): Record<TestCategory, CategorySummary> {
    // This would need access to test category information
    // For now, return placeholder
    return {} as Record<TestCategory, CategorySummary>;
  }
  
  private generateSupervisorTypeSummaries(results: TestResult[]): Record<SupervisorType, SupervisorTypeSummary> {
    // This would need access to supervisor type information
    // For now, return placeholder
    return {} as Record<SupervisorType, SupervisorTypeSummary>;
  }
  
  private generateDecisionPointSummaries(results: TestResult[]): Record<DecisionPoint, DecisionPointSummary> {
    // This would need access to decision point information
    // For now, return placeholder
    return {} as Record<DecisionPoint, DecisionPointSummary>;
  }
  
  /**
   * Generate detailed test report
   */
  private async generateReport(results: TestRunResults): Promise<void> {
    switch (this.config.outputFormat) {
      case 'json':
        await this.generateJSONReport(results);
        break;
      case 'html':
        await this.generateHTMLReport(results);
        break;
      default:
        await this.generateTextReport(results);
    }
  }
  
  private async generateTextReport(results: TestRunResults): Promise<void> {
    const report = this.formatTextReport(results);
    console.log(report);
    
    // Write to file if path specified
    if (this.config.outputPath) {
      await Deno.writeTextFile(`${this.config.outputPath}/hallucination-test-report.txt`, report);
    }
  }
  
  private async generateJSONReport(results: TestRunResults): Promise<void> {
    const json = JSON.stringify(results, null, 2);
    
    if (this.config.outputPath) {
      await Deno.writeTextFile(`${this.config.outputPath}/hallucination-test-report.json`, json);
    }
  }
  
  private async generateHTMLReport(results: TestRunResults): Promise<void> {
    const html = this.formatHTMLReport(results);
    
    if (this.config.outputPath) {
      await Deno.writeTextFile(`${this.config.outputPath}/hallucination-test-report.html`, html);
    }
  }
  
  private formatTextReport(results: TestRunResults): string {
    const { summary } = results;
    
    const report = [
      '='.repeat(80),
      '            ATLAS SUPERVISOR HALLUCINATION TEST REPORT',
      '='.repeat(80),
      `Execution Time: ${results.executionTimeMs}ms`,
      `Timestamp: ${results.timestamp.toISOString()}`,
      '',
      '=== SUMMARY ===',
      `Total Tests: ${summary.totalTests}`,
      `Passed: ${summary.totalPassed} (${((summary.totalPassed / summary.totalTests) * 100).toFixed(1)}%)`,
      `Failed: ${summary.totalFailed} (${((summary.totalFailed / summary.totalTests) * 100).toFixed(1)}%)`,
      `Hallucinations Detected: ${summary.totalHallucinationsDetected}`,
      `Critical Hallucinations: ${summary.criticalHallucinations}`,
      `High Severity Hallucinations: ${summary.highSeverityHallucinations}`,
      '',
      '=== SCORES ===',
      `Average Accuracy Score: ${summary.averageAccuracyScore}/100`,
      `Average Safety Score: ${summary.averageSafetyScore}/100`,
      `Average Context Adherence: ${summary.averageContextAdherenceScore}/100`,
      `Overall Hallucination Risk: ${summary.overallHallucinationRisk}/100`,
      '',
      '=== RISK ASSESSMENT ===',
      this.getRiskAssessment(summary),
      ''
    ];
    
    // Add suite details
    for (const suiteResult of results.suiteResults) {
      report.push(`=== SUITE: ${suiteResult.suiteName} ===`);
      report.push(`Tests: ${suiteResult.testResults.length}`);
      report.push(`Passed: ${suiteResult.passed}`);
      report.push(`Failed: ${suiteResult.failed}`);
      report.push(`Hallucinations: ${suiteResult.hallucinationsDetected}`);
      report.push(`Execution Time: ${suiteResult.executionTimeMs}ms`);
      report.push('');
    }
    
    return report.join('\n');
  }
  
  private formatHTMLReport(results: TestRunResults): string {
    // Simple HTML report template
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Atlas Hallucination Test Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .summary { background: #f5f5f5; padding: 15px; border-radius: 5px; }
        .metric { margin: 5px 0; }
        .critical { color: red; font-weight: bold; }
        .high { color: orange; font-weight: bold; }
        .good { color: green; }
    </style>
</head>
<body>
    <h1>Atlas Supervisor Hallucination Test Report</h1>
    <div class="summary">
        <h2>Summary</h2>
        <div class="metric">Total Tests: ${results.summary.totalTests}</div>
        <div class="metric">Passed: ${results.summary.totalPassed}</div>
        <div class="metric">Failed: ${results.summary.totalFailed}</div>
        <div class="metric">Hallucinations: ${results.summary.totalHallucinationsDetected}</div>
        <div class="metric">Overall Risk: ${results.summary.overallHallucinationRisk}/100</div>
    </div>
    <!-- Additional HTML content would go here -->
</body>
</html>
    `;
  }
  
  private getRiskAssessment(summary: TestRunSummary): string {
    const riskScore = summary.overallHallucinationRisk;
    
    if (riskScore >= 80) {
      return '🔴 CRITICAL RISK: Immediate attention required. Multiple severe hallucinations detected.';
    } else if (riskScore >= 60) {
      return '🟠 HIGH RISK: Review and fix detected issues before production deployment.';
    } else if (riskScore >= 30) {
      return '🟡 MEDIUM RISK: Some issues detected. Consider improvements.';
    } else {
      return '🟢 LOW RISK: Supervisor decisions appear reliable.';
    }
  }
  
  private getTotalTestCount(): number {
    return this.testSuites.reduce((sum, suite) => sum + suite.tests.length, 0);
  }
  
  private reportProgress(progress: TestProgress): void {
    if (this.config.enableProgressReporting && this.progressCallback) {
      this.progressCallback(progress);
    }
  }
}

/**
 * Simple semaphore for controlling concurrency
 */
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];
  
  constructor(permits: number) {
    this.permits = permits;
  }
  
  async acquire<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        if (this.permits > 0) {
          this.permits--;
          task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
              this.permits++;
              if (this.queue.length > 0) {
                const next = this.queue.shift();
                if (next) next();
              }
            });
        } else {
          this.queue.push(tryAcquire);
        }
      };
      
      tryAcquire();
    });
  }
}

export interface TestProgress {
  phase: 'initialization' | 'execution' | 'completion';
  totalSuites: number;
  completedSuites: number;
  totalTests: number;
  completedTests: number;
  currentSuite: string | null;
  currentTest: string | null;
}