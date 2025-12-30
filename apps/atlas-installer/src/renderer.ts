// Renderer process for Atlas Installer
// This file runs in the browser context, not Node.js

import { invoke } from "@tauri-apps/api/core";
import { installMacOSService } from "./services/macos-service.js";
import { installWindowsService } from "./services/windows-service.js";

// Tauri API
const tauriAPI = {
  getPlatform: async (): Promise<string> => {
    return await invoke("get_platform");
  },
  createAtlasDir: async (): Promise<IPCResult> => {
    return await invoke("create_atlas_dir");
  },
  checkExistingApiKey: async (): Promise<IPCResult> => {
    return await invoke("check_existing_api_key");
  },
  saveAtlasNpxPath: async (): Promise<IPCResult> => {
    return await invoke("save_atlas_npx_path");
  },
  saveAtlasNodePath: async (): Promise<IPCResult> => {
    return await invoke("save_atlas_node_path");
  },
  saveAtlasUvPath: async (): Promise<IPCResult> => {
    return await invoke("save_atlas_uv_path");
  },
  saveAtlasClaudePath: async (): Promise<IPCResult> => {
    return await invoke("save_atlas_claude_path");
  },
  saveAtlasKey: async (apiKey: string): Promise<IPCResult> => {
    return await invoke("save_atlas_key", { apiKey });
  },
  installAtlasBinary: async (): Promise<IPCResult> => {
    return await invoke("install_atlas_binary");
  },
  setupPath: async (): Promise<IPCResult> => {
    return await invoke("setup_path");
  },
  checkAtlasBinary: async (): Promise<BinaryCheckResult> => {
    return await invoke("check_atlas_binary");
  },
  manageService: async (action: string): Promise<IPCResult> => {
    return await invoke("manage_atlas_service", { action });
  },
  getEulaText: async (): Promise<string> => {
    return await invoke("get_eula_text");
  },
  launchWebClient: async (): Promise<IPCResult> => {
    return await invoke("launch_web_client");
  },
  quitApp: async (): Promise<void> => {
    await invoke("quit_app");
  },
};

// Type definitions must be at top level for TypeScript
interface IPCResult {
  success: boolean;
  message?: string;
  error?: string;
}

interface BinaryCheckResult {
  exists: boolean;
  path?: string;
  error?: string;
}

// Wrap execution code in IIFE to avoid CommonJS exports issue
(() => {
  interface InstallationStep {
    progress: number;
    message: string;
    action: () => Promise<IPCResult>;
  }

  // JWT payload type for Atlas Access Key validation
  // Defined inline since we can't import Node modules in browser context
  type JWTPayload = {
    email: string;
    iss: string;
    sub: string;
    exp: number;
    iat: number;
    nbf?: number;
  };

  class AtlasInstaller {
    private currentStep: number = 0;
    private readonly totalSteps: number = 4;
    private isInstalling: boolean = false;

    constructor() {
      this.initializeEventListeners();
      this.loadLicenseText();
      this.loadPlatformInfo();
    }

    private async loadPlatformInfo(): Promise<void> {
      try {
        const platform = await tauriAPI.getPlatform();
        // Tauri returns just the platform string, not full PlatformInfo
        console.log("Platform:", platform);
      } catch (error) {
        console.error("Failed to load platform info:", error);
      }
    }

    private initializeEventListeners(): void {
      const nextBtn = document.getElementById("next-btn") as HTMLButtonElement | null;
      const backBtn = document.getElementById("back-btn") as HTMLButtonElement | null;
      const licenseCheckbox = document.getElementById(
        "license-checkbox",
      ) as HTMLInputElement | null;
      const apiKeyInput = document.getElementById("api-key") as HTMLInputElement | null;
      const showHideBtn = document.getElementById("show-hide-btn") as HTMLButtonElement | null;

      if (!nextBtn || !backBtn || !licenseCheckbox || !apiKeyInput || !showHideBtn) {
        throw new Error("Required UI elements not found");
      }

      nextBtn.addEventListener("click", () => this.handleNext());
      backBtn.addEventListener("click", () => this.handleBack());
      licenseCheckbox.addEventListener("change", () => this.updateNextButton());
      apiKeyInput.addEventListener("input", (e) => {
        const target = e.target as HTMLInputElement;
        this.handleAtlasKeyInput(target.value);
      });
      showHideBtn.addEventListener("click", () => this.toggleApiKeyVisibility());

      // Installation progress is handled via UI updates in startInstallation
      // Tauri doesn't support event listeners in the same way as Electron
    }

    private async loadLicenseText(): Promise<void> {
      try {
        const licenseText = await tauriAPI.getEulaText();
        const licenseElement = document.getElementById("license-text") as HTMLElement | null;
        if (licenseElement) {
          licenseElement.textContent = licenseText;
        }
      } catch (error) {
        console.error("Failed to load EULA:", error);
        const licenseElement = document.getElementById("license-text") as HTMLElement | null;
        if (licenseElement) {
          licenseElement.textContent = "Error loading license text. Please contact support.";
        }
      }
    }

    private validateAtlasKey(atlasKey: string): boolean {
      // Empty is valid (skip case)
      if (!atlasKey || atlasKey.trim() === "") return true;

      try {
        // Use a more robust JWT decoding approach
        const parts = atlasKey.trim().split(".");
        if (parts.length !== 3) return false;

        // Decode base64url properly
        const base64urlDecode = (str: string): string => {
          // Replace URL-safe characters
          str = str.replace(/-/g, "+").replace(/_/g, "/");
          // Add padding if needed
          while (str.length % 4) {
            str += "=";
          }
          return atob(str);
        };

        // Decode and parse the payload
        let payload: JWTPayload;
        try {
          const payloadPart = parts[1];
          if (!payloadPart) return false;
          const decodedPayload = base64urlDecode(payloadPart);
          payload = JSON.parse(decodedPayload);
        } catch {
          return false;
        }

        // Check for required claims
        if (!payload.email || !payload.iss || !payload.sub || !payload.exp || !payload.iat) {
          return false;
        }

        // Check if issuer is correct (support both formats)
        if (payload.iss !== "tempest-atlas" && payload.iss !== "https://hellofriday.ai") {
          return false;
        }

        // Check if token is expired (with 30 second buffer for clock skew)
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp <= now - 30) {
          // Changed to subtract buffer (token expired if exp is in the past)
          return false;
        }

        // Check if token is not valid yet (nbf claim if present)
        if (payload.nbf && payload.nbf > now + 30) {
          // Add buffer for not-before
          return false;
        }

        return true;
      } catch (error) {
        console.error("JWT validation error:", error);
        return false;
      }
    }

    private isAtlasKeyValid(): boolean {
      const apiKeyInput = document.getElementById("api-key") as HTMLInputElement | null;
      if (!apiKeyInput) return false;
      return this.validateAtlasKey(apiKeyInput.value);
    }

    private toggleApiKeyVisibility(): void {
      const apiKeyInput = document.getElementById("api-key") as HTMLInputElement | null;
      const eyeIcon = document.getElementById("eye-icon") as HTMLElement | null;

      if (!apiKeyInput || !eyeIcon) return;

      if (apiKeyInput.type === "password") {
        apiKeyInput.type = "text";
        eyeIcon.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.58838 11.351L2.46971 12.4697C2.17682 12.7626 2.17682 13.2374 2.46971 13.5303C2.76261 13.8232 3.23748 13.8232 3.53037 13.5303L4.85381 12.2069C5.74039 12.6822 6.7868 13 8.00004 13C11.3217 13 13.3928 10.6181 14.3572 9.14224C14.815 8.44183 14.815 7.55817 14.3572 6.85776C13.93 6.20404 13.2857 5.37253 12.4117 4.649L13.5304 3.53033C13.8233 3.23744 13.8233 2.76256 13.5304 2.46967C13.2375 2.17678 12.7626 2.17678 12.4697 2.46967L11.1463 3.79311C10.2597 3.31778 9.21328 3 8.00004 3C4.67841 3 2.6073 5.38195 1.64285 6.85776C1.18513 7.55817 1.18513 8.44183 1.64285 9.14224C2.07006 9.79596 2.7144 10.6275 3.58838 11.351ZM5.97768 11.083C6.5783 11.3414 7.25187 11.5 8.00004 11.5C10.5369 11.5 12.2161 9.67671 13.1016 8.32167C13.2335 8.1198 13.2335 7.8802 13.1016 7.67833C12.6899 7.04838 12.1067 6.31724 11.3456 5.71514L5.97768 11.083ZM10.0224 4.91698L4.65452 10.2849C3.89337 9.68276 3.31017 8.95162 2.8985 8.32167C2.76658 8.1198 2.76658 7.8802 2.8985 7.67833C3.78402 6.32329 5.46318 4.5 8.00004 4.5C8.74822 4.5 9.42179 4.65859 10.0224 4.91698Z" fill="black"/></svg>';
      } else {
        apiKeyInput.type = "password";
        eyeIcon.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.1015 8.32167C12.216 9.67671 10.5368 11.5 7.99998 11.5C5.46312 11.5 3.78396 9.67671 2.89844 8.32167C2.76652 8.1198 2.76652 7.8802 2.89844 7.67833C3.78396 6.32329 5.46312 4.5 7.99998 4.5C10.5368 4.5 12.216 6.32329 13.1015 7.67833C13.2334 7.8802 13.2334 8.1198 13.1015 8.32167ZM14.3572 6.85776C14.8149 7.55817 14.8149 8.44183 14.3572 9.14224C13.3927 10.6181 11.3216 13 7.99998 13C4.67835 13 2.60723 10.6181 1.64279 9.14224C1.18507 8.44183 1.18507 7.55817 1.64279 6.85776C2.60723 5.38195 4.67835 3 7.99998 3C11.3216 3 13.3927 5.38195 14.3572 6.85776ZM7.99998 10C9.10455 10 9.99998 9.10457 9.99998 8C9.99998 6.89543 9.10455 6 7.99998 6C6.89541 6 5.99998 6.89543 5.99998 8C5.99998 9.10457 6.89541 10 7.99998 10Z" fill="black"/></svg>';
      }
    }

    private handleAtlasKeyInput(value: string): void {
      const validationEl = document.getElementById("api-key-validation") as HTMLElement | null;
      if (!validationEl) return;

      if (!value || value.trim() === "") {
        // Empty is valid (skip case)
        validationEl.classList.add("hidden");
      } else if (this.validateAtlasKey(value)) {
        // Valid Atlas Access Key format
        validationEl.classList.add("hidden");
      } else {
        // Invalid Atlas Access Key format - show error and prevent continue
        validationEl.textContent = "Invalid Atlas Access Key. Please check your key and try again.";
        validationEl.classList.remove("hidden");
      }

      this.updateNextButton();
    }

    private updateStepIndicator(): void {
      for (let i = 0; i <= this.totalSteps; i++) {
        const stepElement = document.getElementById(`step-${i}`) as HTMLElement | null;
        const contentElement = document.getElementById(`content-${i}`) as HTMLElement | null;

        if (stepElement) {
          stepElement.classList.remove("active", "completed");
          if (i < this.currentStep) {
            stepElement.classList.add("completed");
          } else if (i === this.currentStep) {
            stepElement.classList.add("active");
          }
        }

        if (contentElement) {
          contentElement.classList.remove("active");
          if (i === this.currentStep) {
            contentElement.classList.add("active");
          }
        }
      }

      this.updateNavigationButtons();
    }

    private updateNavigationButtons(): void {
      const backBtn = document.getElementById("back-btn") as HTMLButtonElement | null;
      const nextBtn = document.getElementById("next-btn") as HTMLButtonElement | null;

      if (!backBtn || !nextBtn) return;

      // Back button
      if (this.currentStep > 1 && this.currentStep < this.totalSteps && !this.isInstalling) {
        backBtn.classList.remove("hidden");
      } else {
        backBtn.classList.add("hidden");
      }

      // Next button
      this.updateNextButton();
    }

    private updateNextButton(): void {
      const nextBtn = document.getElementById("next-btn") as HTMLButtonElement | null;
      if (!nextBtn) return;

      switch (this.currentStep) {
        case 0: // Welcome
          nextBtn.textContent = "Continue";
          nextBtn.disabled = false;
          nextBtn.className = "btn btn-primary";
          break;

        case 1: {
          // License
          const licenseCheckbox = document.getElementById(
            "license-checkbox",
          ) as HTMLInputElement | null;
          const licenseAccepted = licenseCheckbox?.checked ?? false;
          nextBtn.textContent = "Agree & Continue";
          nextBtn.disabled = !licenseAccepted;
          nextBtn.className = "btn btn-primary";
          break;
        }

        case 2: {
          // Atlas Access Key
          const isAtlasKeyValid = this.isAtlasKeyValid();
          nextBtn.textContent = "Continue";
          nextBtn.disabled = !isAtlasKeyValid;
          nextBtn.className = "btn btn-primary";
          break;
        }

        case 3: // Installation
          if (this.isInstalling) {
            nextBtn.classList.add("hidden");
          } else {
            nextBtn.classList.remove("hidden");
            nextBtn.textContent = "Install Atlas";
            nextBtn.disabled = false;
          }
          break;

        case 4: // Completion
          nextBtn.textContent = "Launch Atlas";
          nextBtn.disabled = false;
          nextBtn.className = "btn btn-primary";
          break;
      }
    }

    private async handleNext(): Promise<void> {
      try {
        switch (this.currentStep) {
          case 0: // Welcome -> License
            this.currentStep = 1;
            break;

          case 1: {
            // License -> API Key
            const licenseCheckbox = document.getElementById(
              "license-checkbox",
            ) as HTMLInputElement | null;
            if (licenseCheckbox?.checked) {
              this.currentStep = 2;
            }
            break;
          }

          case 2: // API Key -> Installation
            this.prepareInstallation();
            this.currentStep = 3;
            break;

          case 3: // Start Installation
            await this.startInstallation();
            break;

          case 4: {
            // Launch Atlas - always launch web client
            try {
              await tauriAPI.launchWebClient();
            } catch (err) {
              console.warn("Failed to launch web client:", err);
              // Continue to quit even if launch fails
            }

            await tauriAPI.quitApp();
            break;
          }
        }

        this.updateStepIndicator();
      } catch (error) {
        console.error("Error in handleNext:", error);
        // Handle error appropriately - could show error dialog
      }
    }

    private handleBack(): void {
      if (this.currentStep > 0 && !this.isInstalling) {
        this.currentStep--;
        this.updateStepIndicator();
      }
    }

    private prepareInstallation(): void {
      const apiKeyInput = document.getElementById("api-key") as HTMLInputElement | null;
      const apiKeyItem = document.getElementById("api-key-item") as HTMLElement | null;

      if (!apiKeyInput || !apiKeyItem) return;

      const atlasKey = apiKeyInput.value;
      if (atlasKey.trim()) {
        apiKeyItem.classList.remove("hidden");
      } else {
        apiKeyItem.classList.add("hidden");
      }
    }

    private async startInstallation(): Promise<void> {
      this.isInstalling = true;
      this.updateNextButton();

      // Show progress UI
      const installDescription = document.getElementById(
        "install-description",
      ) as HTMLElement | null;
      const installSummary = document.getElementById("install-summary") as HTMLElement | null;
      const progressContainer = document.getElementById("progress-container") as HTMLElement | null;

      if (installDescription) {
        installDescription.textContent = "Please wait while Atlas is being installed.";
      }
      if (installSummary) {
        installSummary.classList.add("hidden");
      }
      if (progressContainer) {
        progressContainer.classList.remove("hidden");
      }

      const steps: InstallationStep[] = [
        {
          progress: 10,
          message: "Creating Atlas directory...",
          action: () => tauriAPI.createAtlasDir(),
        },
        {
          progress: 20,
          message: "Configuring NPX path for MCP servers...",
          action: () => tauriAPI.saveAtlasNpxPath(),
        },
        {
          progress: 30,
          message: "Configuring Node path for Claude Code agent...",
          action: () => tauriAPI.saveAtlasNodePath(),
        },
        {
          progress: 35,
          message: "Configuring UV path for Python agents...",
          action: () => tauriAPI.saveAtlasUvPath(),
        },
        {
          progress: 45,
          message: "Configuring Claude CLI path for claude-code agent...",
          action: () => tauriAPI.saveAtlasClaudePath(),
        },
        {
          progress: 55,
          message: "Installing Atlas binary...",
          action: () => tauriAPI.installAtlasBinary(),
        },
        {
          progress: 60,
          message: "Saving Atlas Access Key configuration...",
          action: () => this.configureCredentials(),
        },
        { progress: 70, message: "Setting up PATH...", action: () => tauriAPI.setupPath() },
        {
          progress: 85,
          message: "Installing and starting Atlas service...",
          action: () => this.manageDaemon(),
        },
        {
          progress: 100,
          message: "Installation complete!",
          action: (): Promise<IPCResult> => Promise.resolve({ success: true }),
        },
      ];

      let log = "";
      let currentProgress = 0; // Track actual progress

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step) continue; // Skip if undefined
        const previousStep = i > 0 ? steps[i - 1] : null;
        const previousProgress = previousStep ? previousStep.progress : 0;

        // Add step with "in progress" indicator but keep previous progress
        log += `→ ${step.message}\n`;
        this.updateInstallationUI(previousProgress, log);

        // Force UI update and ensure rendering completes before long operations
        // Use requestAnimationFrame + setTimeout to guarantee UI paint
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            setTimeout(resolve, 250); // Give UI time to fully render
          });
        });

        try {
          const result = await step.action();

          // Check if result is undefined or not an object
          if (!result || typeof result !== "object") {
            console.error("Invalid result from step action:", result);
            throw new Error("Step action returned invalid result");
          }

          // Remove the "in progress" line and add completion status
          const lines = log.split("\n");
          lines.pop(); // Remove empty line
          lines.pop(); // Remove the "in progress" line

          if (result.success) {
            if (result.message?.includes("warning")) {
              lines.push(`⚠️  ${step.message.replace("...", "")}`);
              lines.push(`    └─ ${result.message}`);
            } else {
              lines.push(`✓  ${step.message.replace("...", "")}`);
            }
            // Update progress only after successful completion
            currentProgress = step.progress;
          } else {
            lines.push(`✗  ${step.message.replace("...", "")}`);
            lines.push(`    └─ ${result.error || "Unknown error"}`);
            // If there's a detailed message, show it as well
            if (result.message) {
              const messageLines = result.message.split("\n");
              messageLines.forEach((line) => {
                if (line.trim()) {
                  lines.push(`       ${line}`);
                }
              });
            }
            // Keep progress at previous level on failure
            currentProgress = previousProgress;
          }

          log = `${lines.join("\n")}\n`;
          // Update UI with the actual current progress
          this.updateInstallationUI(currentProgress, log);
        } catch (error) {
          // Remove the "in progress" line and add error status
          const lines = log.split("\n");
          lines.pop(); // Remove empty line
          lines.pop(); // Remove the "in progress" line

          const errorMessage = error instanceof Error ? error.message : String(error);
          lines.push(`✗  ${step.message.replace("...", "")}`);
          lines.push(`    └─ ${errorMessage}`);

          log = `${lines.join("\n")}\n`;
          // Keep progress at previous level on error
          currentProgress = previousProgress;
          this.updateInstallationUI(currentProgress, log);
        }

        // Simulate realistic timing
        await new Promise((resolve) => setTimeout(resolve, 800));
      }

      // Move to completion step
      setTimeout(() => {
        this.currentStep = 4;
        this.isInstalling = false;
        this.updateCompletionStatus();
        this.updateStepIndicator();
      }, 1000);
    }

    private async configureCredentials(): Promise<IPCResult> {
      const apiKeyInput = document.getElementById("api-key") as HTMLInputElement | null;
      if (!apiKeyInput) {
        return { success: false, error: "API key input element not found" };
      }

      const atlasKey = apiKeyInput.value;

      if (atlasKey?.trim()) {
        // User provided an Atlas Access Key - validate and save it
        if (this.validateAtlasKey(atlasKey)) {
          try {
            // Save the Atlas Access Key to .env file
            const saveResult = await tauriAPI.saveAtlasKey(atlasKey.trim());
            return saveResult;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Failed to save Atlas Access Key: ${errorMessage}` };
          }
        } else {
          return {
            success: false,
            error: "Invalid Atlas Access Key format. Cannot proceed with installation.",
          };
        }
      } else {
        // No Atlas Access Key provided - skip configuration step
        return {
          success: true,
          message: "Atlas Access Key configuration skipped - no changes made",
        };
      }
    }

    private async manageDaemon(): Promise<IPCResult> {
      try {
        // Check if Atlas binary was successfully installed before trying to start service
        const binaryCheck: BinaryCheckResult = await tauriAPI.checkAtlasBinary();
        if (!binaryCheck.exists || !binaryCheck.path) {
          return {
            success: false,
            error: `Atlas binary not found at expected location. Binary installation may have failed: ${
              binaryCheck.error || "Binary not accessible"
            }`,
          };
        }

        // Install and start Atlas service using platform-specific logic
        const isWindows = navigator.userAgent.includes("Windows");
        const installResult = isWindows
          ? await installWindowsService(binaryCheck.path)
          : await installMacOSService(binaryCheck.path);
        if (!installResult.success) {
          // Check if the error message already contains detailed instructions
          if (installResult.message) {
            // Return the full error with detailed instructions
            return {
              success: false,
              error: installResult.error || "Service installation failed",
              message: installResult.message,
            };
          } else {
            const isWindows = navigator.userAgent.includes("Windows");
            const manualCommand = isWindows
              ? "Please approve the UAC prompt or run installer as Administrator"
              : "atlas service install && atlas service start";
            // Return FAILURE when service install fails - don't hide it as success!
            return {
              success: false,
              error: `Service install failed: ${installResult.error}. ${manualCommand}`,
            };
          }
        }
        return installResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Return the actual error - don't hide it as success!
        return { success: false, error: `Service installation failed: ${errorMessage}` };
      }
    }

    private updateInstallationUI(progress: number, log: string): void {
      const progressFill = document.getElementById("progress-fill") as HTMLElement | null;
      const progressText = document.getElementById("progress-text") as HTMLElement | null;
      const installLog = document.getElementById("install-log") as HTMLElement | null;

      if (progressFill) {
        progressFill.style.width = `${progress}%`;
      }
      if (progressText) {
        progressText.textContent = `${progress}% Complete`;
      }
      if (installLog) {
        // Convert the log to HTML with colored status indicators
        const htmlLog = log
          .split("\n")
          .map((line) => {
            if (line.startsWith("✓")) {
              return `<div style="color: #10b981; font-weight: 500;">${this.escapeHtml(line)}</div>`;
            } else if (line.startsWith("✗")) {
              return `<div style="color: #ef4444; font-weight: 500;">${this.escapeHtml(line)}</div>`;
            } else if (line.startsWith("⚠️")) {
              return `<div style="color: #f59e0b; font-weight: 500;">${this.escapeHtml(line)}</div>`;
            } else if (line.startsWith("→")) {
              return `<div style="color: #8b8d98;">${this.escapeHtml(line)}</div>`;
            } else if (line.startsWith("    └─")) {
              return `<div style="color: #6b7280; margin-left: 20px; font-size: 0.9em;">${this.escapeHtml(line)}</div>`;
            } else {
              return `<div>${this.escapeHtml(line)}</div>`;
            }
          })
          .join("");

        installLog.innerHTML = htmlLog;
        // Auto-scroll to bottom
        installLog.scrollTop = installLog.scrollHeight;
      }
    }

    private escapeHtml(text: string): string {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }

    private updateCompletionStatus(): void {
      // Show credential status if they were configured
      const apiKeyInput = document.getElementById("api-key") as HTMLInputElement | null;
      const apiKeyStatus = document.getElementById("api-key-status") as HTMLElement | null;

      if (apiKeyInput && apiKeyStatus) {
        const atlasKey = apiKeyInput.value;
        if (atlasKey?.trim() && this.validateAtlasKey(atlasKey)) {
          apiKeyStatus.classList.remove("hidden");
        }
      }

      // Update daemon status based on installation log
      const daemonStatus = document.getElementById("daemon-status") as HTMLElement | null;
      const installLog = document.getElementById("install-log") as HTMLElement | null;

      if (daemonStatus && installLog) {
        const installLogContent = installLog.textContent || "";

        if (installLogContent.includes("Starting Atlas daemon...")) {
          if (
            installLogContent.includes("[OK] Starting Atlas daemon completed") ||
            installLogContent.includes("[WARNING] Starting Atlas daemon completed with warning")
          ) {
            // Daemon step completed successfully or with warning
            if (installLogContent.includes("warning")) {
              daemonStatus.textContent = "Atlas daemon - check manually with 'atlas daemon status'";
              daemonStatus.style.color = "#f39c12";
            } else {
              daemonStatus.textContent = "Atlas daemon started and running";
            }
          } else if (
            installLogContent.includes("[ERROR]") &&
            installLogContent.lastIndexOf("[ERROR]") >
              installLogContent.lastIndexOf("Starting Atlas daemon...")
          ) {
            // Daemon step failed
            daemonStatus.textContent = "Atlas daemon - start manually with 'atlas daemon start'";
            daemonStatus.style.color = "#e74c3c";
          }
        }
      }
    }
  }

  // Initialize the installer when the page loads
  // Check if DOM is already loaded (in case script loads after DOMContentLoaded)
  const initInstaller = () => {
    try {
      new AtlasInstaller();
    } catch (error) {
      console.error("Failed to initialize AtlasInstaller:", error);
      document.body.innerHTML = `<div style="padding: 20px; color: red;">
        <h1>Initialization Error</h1>
        <pre>${error instanceof Error ? error.stack : String(error)}</pre>
      </div>`;
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initInstaller);
  } else {
    // DOM is already loaded, execute immediately
    initInstaller();
  }
})(); // End IIFE
