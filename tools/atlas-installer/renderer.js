class AtlasInstaller {
  constructor() {
    this.currentStep = 0;
    this.totalSteps = 4;
    this.isInstalling = false;
    this.platformInfo = null;

    this.initializeEventListeners();
    this.loadLicenseText();
    this.loadPlatformInfo();
  }

  async loadPlatformInfo() {
    try {
      this.platformInfo = await globalThis.electronAPI.getPlatform();
      console.log("Platform info:", this.platformInfo);
    } catch (error) {
      console.error("Failed to load platform info:", error);
    }
  }

  initializeEventListeners() {
    document.getElementById("next-btn").addEventListener("click", () => this.handleNext());

    document.getElementById("back-btn").addEventListener("click", () => this.handleBack());

    document.getElementById("license-checkbox").addEventListener("change", (e) => {
      this.updateNextButton();
    });

    document.getElementById("api-key").addEventListener("input", (e) => {
      this.handleAtlasKeyInput(e.target.value);
    });

    document.getElementById("show-hide-btn").addEventListener("click", () => {
      this.toggleApiKeyVisibility();
    });

    // Listen for installation progress updates from main process
    if (globalThis.electronAPI && globalThis.electronAPI.onInstallationProgress) {
      globalThis.electronAPI.onInstallationProgress((message) => {
        // Update the installation log with progress messages
        const logElement = document.getElementById("installation-log");
        if (logElement && message) {
          const currentLog = logElement.value;
          logElement.value = currentLog + `→ ${message}\n`;
          logElement.scrollTop = logElement.scrollHeight;
        }
      });
    }
  }

  async loadLicenseText() {
    try {
      // Request the EULA text from the main process
      const licenseText = await globalThis.electronAPI.getEulaText();
      document.getElementById("license-text").textContent = licenseText;
    } catch (error) {
      console.error("Failed to load EULA:", error);
      document.getElementById("license-text").textContent =
        "Error loading license text. Please contact support.";
    }
  }

  validateAtlasKey(atlasKey) {
    // Empty is valid (skip case)
    if (!atlasKey || atlasKey.trim() === "") return true;

    try {
      // Check if it's a valid JWT format (3 parts separated by dots)
      const parts = atlasKey.trim().split(".");
      if (parts.length !== 3) return false;

      // Check if parts are non-empty and valid base64url
      if (!parts[0] || !parts[1] || !parts[2]) return false;

      // Decode the payload to check claims
      // Add padding if needed for base64 decoding
      let payload64 = parts[1];
      while (payload64.length % 4) {
        payload64 += "=";
      }

      const payload = JSON.parse(atob(payload64));

      // Check for required claims
      if (!payload.email || !payload.iss || !payload.sub || !payload.exp || !payload.iat) {
        return false;
      }

      // Check if issuer is correct
      if (payload.iss !== "tempest-atlas") {
        return false;
      }

      // Check if token is expired (with 30 second buffer for clock skew)
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now + 30) {
        return false;
      }

      // Check if token is not valid yet (nbf claim if present)
      if (payload.nbf && payload.nbf > now) {
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  isAtlasKeyValid() {
    const atlasKey = document.getElementById("api-key").value;
    return this.validateAtlasKey(atlasKey);
  }

  hasValidAtlasKey() {
    const atlasKey = document.getElementById("api-key").value;
    return atlasKey && atlasKey.trim() && this.validateAtlasKey(atlasKey);
  }

  async hasExistingCredentials() {
    // Check if credentials already exist in ~/.atlas/.env
    try {
      const result = await globalThis.electronAPI.checkExistingApiKey();
      return result.exists;
    } catch {
      return false;
    }
  }

  toggleApiKeyVisibility() {
    const apiKeyInput = document.getElementById("api-key");
    const eyeIcon = document.getElementById("eye-icon");

    if (apiKeyInput.type === "password") {
      apiKeyInput.type = "text";
      eyeIcon.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.58838 11.351L2.46971 12.4697C2.17682 12.7626 2.17682 13.2374 2.46971 13.5303C2.76261 13.8232 3.23748 13.8232 3.53037 13.5303L4.85381 12.2069C5.74039 12.6822 6.7868 13 8.00004 13C11.3217 13 13.3928 10.6181 14.3572 9.14224C14.815 8.44183 14.815 7.55817 14.3572 6.85776C13.93 6.20404 13.2857 5.37253 12.4117 4.649L13.5304 3.53033C13.8233 3.23744 13.8233 2.76256 13.5304 2.46967C13.2375 2.17678 12.7626 2.17678 12.4697 2.46967L11.1463 3.79311C10.2597 3.31778 9.21328 3 8.00004 3C4.67841 3 2.6073 5.38195 1.64285 6.85776C1.18513 7.55817 1.18513 8.44183 1.64285 9.14224C2.07006 9.79596 2.7144 10.6275 3.58838 11.351ZM5.97768 11.083C6.5783 11.3414 7.25187 11.5 8.00004 11.5C10.5369 11.5 12.2161 9.67671 13.1016 8.32167C13.2335 8.1198 13.2335 7.8802 13.1016 7.67833C12.6899 7.04838 12.1067 6.31724 11.3456 5.71514L5.97768 11.083ZM10.0224 4.91698L4.65452 10.2849C3.89337 9.68276 3.31017 8.95162 2.8985 8.32167C2.76658 8.1198 2.76658 7.8802 2.8985 7.67833C3.78402 6.32329 5.46318 4.5 8.00004 4.5C8.74822 4.5 9.42179 4.65859 10.0224 4.91698Z" fill="black"/></svg>'; // Closed eye when showing
    } else {
      apiKeyInput.type = "password";
      eyeIcon.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.1015 8.32167C12.216 9.67671 10.5368 11.5 7.99998 11.5C5.46312 11.5 3.78396 9.67671 2.89844 8.32167C2.76652 8.1198 2.76652 7.8802 2.89844 7.67833C3.78396 6.32329 5.46312 4.5 7.99998 4.5C10.5368 4.5 12.216 6.32329 13.1015 7.67833C13.2334 7.8802 13.2334 8.1198 13.1015 8.32167ZM14.3572 6.85776C14.8149 7.55817 14.8149 8.44183 14.3572 9.14224C13.3927 10.6181 11.3216 13 7.99998 13C4.67835 13 2.60723 10.6181 1.64279 9.14224C1.18507 8.44183 1.18507 7.55817 1.64279 6.85776C2.60723 5.38195 4.67835 3 7.99998 3C11.3216 3 13.3927 5.38195 14.3572 6.85776ZM7.99998 10C9.10455 10 9.99998 9.10457 9.99998 8C9.99998 6.89543 9.10455 6 7.99998 6C6.89541 6 5.99998 6.89543 5.99998 8C5.99998 9.10457 6.89541 10 7.99998 10Z" fill="black"/></svg>'; // Open eye when hidden
    }
  }

  handleAtlasKeyInput(value) {
    const validationEl = document.getElementById("api-key-validation");

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

  updateStepIndicator() {
    for (let i = 0; i <= this.totalSteps; i++) {
      const stepElement = document.getElementById(`step-${i}`);
      const contentElement = document.getElementById(`content-${i}`);

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

  updateNavigationButtons() {
    const backBtn = document.getElementById("back-btn");
    const nextBtn = document.getElementById("next-btn");

    // Back button
    if (this.currentStep > 1 && this.currentStep < this.totalSteps && !this.isInstalling) {
      backBtn.classList.remove("hidden");
    } else {
      backBtn.classList.add("hidden");
    }

    // Next button
    this.updateNextButton();
  }

  updateNextButton() {
    const nextBtn = document.getElementById("next-btn");

    switch (this.currentStep) {
      case 0: // Welcome
        nextBtn.textContent = "Continue";
        nextBtn.disabled = false;
        nextBtn.className = "btn btn-primary";
        break;

      case 1: {
        // License
        const licenseAccepted = document.getElementById("license-checkbox").checked;
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
        nextBtn.textContent = "Finish";
        nextBtn.disabled = false;
        nextBtn.className = "btn btn-primary";
        break;
    }
  }

  async handleNext() {
    switch (this.currentStep) {
      case 0: // Welcome -> License
        this.currentStep = 1;
        break;

      case 1: // License -> API Key
        if (document.getElementById("license-checkbox").checked) {
          this.currentStep = 2;
        }
        break;

      case 2: // API Key -> Installation
        this.prepareInstallation();
        this.currentStep = 3;
        break;

      case 3: // Start Installation
        await this.startInstallation();
        break;

      case 4: // Finish
        await globalThis.electronAPI.quitApp();
        break;
    }

    this.updateStepIndicator();
  }

  handleBack() {
    if (this.currentStep > 0 && !this.isInstalling) {
      this.currentStep--;
      this.updateStepIndicator();
    }
  }

  prepareInstallation() {
    const atlasKey = document.getElementById("api-key").value;
    const apiKeyItem = document.getElementById("api-key-item");

    if (atlasKey.trim()) {
      apiKeyItem.classList.remove("hidden");
    } else {
      apiKeyItem.classList.add("hidden");
    }
  }

  async startInstallation() {
    this.isInstalling = true;
    this.updateNextButton();

    // Show progress UI
    document.getElementById("install-description").textContent =
      "Please wait while Atlas is being installed.";
    document.getElementById("install-summary").classList.add("hidden");
    document.getElementById("progress-container").classList.remove("hidden");

    const steps = [
      {
        progress: 14,
        message: "Creating Atlas directory...",
        action: () => globalThis.electronAPI.createAtlasDir(),
      },
      {
        progress: 28,
        message: "Configuring NPX path for MCP servers...",
        action: () => globalThis.electronAPI.ensureNpxPath(),
      },
      {
        progress: 42,
        message: "Installing Atlas binary...",
        action: () => globalThis.electronAPI.installAtlasBinary(),
      },
      {
        progress: 56,
        message: "Saving Atlas Access Key configuration...",
        action: () => this.configureCredentials(),
      },
      {
        progress: 70,
        message: "Setting up PATH...",
        action: () => globalThis.electronAPI.setupPath(),
      },
      { progress: 84, message: "Starting Atlas service...", action: () => this.manageDaemon() },
      {
        progress: 100,
        message: "Installation complete!",
        action: () => Promise.resolve({ success: true }),
      },
    ];

    let log = "";

    for (const step of steps) {
      log += `${step.message}\n`;
      this.updateInstallationUI(step.progress, log);

      try {
        const result = await step.action();
        if (result.success) {
          if (result.warning) {
            log += `⚠ ${step.message.replace("...", " completed with warning")}\n`;
            log += `  ${result.warning}\n`;
          } else {
            log += `✓ ${step.message.replace("...", " completed")}\n`;
          }
        } else {
          log += `✗ Error: ${result.error}\n`;
        }
      } catch (error) {
        log += `✗ Error: ${error.message}\n`;
      }

      this.updateInstallationUI(step.progress, log);

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

  async configureCredentials() {
    const atlasKey = document.getElementById("api-key").value;

    if (atlasKey && atlasKey.trim()) {
      // User provided an Atlas Access Key - validate and save it
      if (this.validateAtlasKey(atlasKey)) {
        try {
          // Save the Atlas Access Key to .env file
          const saveResult = await globalThis.electronAPI.saveAtlasKey(atlasKey.trim());
          return saveResult;
        } catch (error) {
          return { success: false, error: `Failed to save Atlas Access Key: ${error.message}` };
        }
      } else {
        return {
          success: false,
          error: "Invalid Atlas Access Key format. Cannot proceed with installation.",
        };
      }
    } else {
      // No Atlas Access Key provided - skip configuration step
      return { success: true, message: "Atlas Access Key configuration skipped - no changes made" };
    }
  }

  async manageDaemon() {
    try {
      // Check if credentials exist (either just fetched or already in file)
      const hasInputAtlasKey = this.hasValidAtlasKey();
      const hasExistingCredentials = await this.hasExistingCredentials();

      if (!hasInputAtlasKey && !hasExistingCredentials) {
        // No credentials available - Atlas daemon will return error about it when started
        return {
          success: true,
          message:
            "Daemon start skipped - no credentials configured. Configure credentials in ~/.atlas/.env and run 'atlas service start'.",
        };
      }

      // Check if Atlas binary was successfully installed before trying to start service
      const binaryCheck = await globalThis.electronAPI.checkAtlasBinary();
      if (!binaryCheck.exists) {
        return {
          success: false,
          error: `Atlas binary not found at expected location. Binary installation may have failed: ${
            binaryCheck.error || "Binary not accessible"
          }`,
        };
      }

      // Start Atlas service (on Windows this will create scheduled task if needed)
      const startResult = await globalThis.electronAPI.manageService("start");
      if (!startResult.success) {
        const platform = navigator.userAgent.includes("Windows") ? "windows" : "unix";
        const manualCommand =
          platform === "windows"
            ? "Run installer as Administrator or manually create scheduled task"
            : "atlas service install && atlas service start";
        return {
          success: true,
          warning: `Service start failed: ${startResult.error}. ${manualCommand}`,
        };
      }
      return startResult;
    } catch (error) {
      // If daemon management fails, continue with warning
      return {
        success: true,
        warning: `Daemon management error: ${error.message}. Start manually with 'atlas daemon start'.`,
      };
    }
  }

  updateInstallationUI(progress, log) {
    document.getElementById("progress-fill").style.width = `${progress}%`;
    document.getElementById("progress-text").textContent = `${progress}% Complete`;
    document.getElementById("install-log").textContent = log;

    // Auto-scroll to bottom
    const logElement = document.getElementById("install-log");
    logElement.scrollTop = logElement.scrollHeight;
  }

  updateCompletionStatus() {
    // Show credential status if they were configured
    const atlasKey = document.getElementById("api-key").value;
    const apiKeyStatus = document.getElementById("api-key-status");

    if (atlasKey && atlasKey.trim() && this.validateAtlasKey(atlasKey)) {
      apiKeyStatus.classList.remove("hidden");
    }

    // Update daemon status based on installation log
    const daemonStatus = document.getElementById("daemon-status");
    const installLog = document.getElementById("install-log").textContent;

    if (installLog.includes("Starting Atlas daemon...")) {
      if (
        installLog.includes("✓ Starting Atlas daemon completed") ||
        installLog.includes("⚠ Starting Atlas daemon completed with warning")
      ) {
        // Daemon step completed successfully or with warning
        if (installLog.includes("warning")) {
          daemonStatus.textContent = "⚠️ Atlas daemon - check manually with 'atlas daemon status'";
          daemonStatus.style.color = "#f39c12";
        } else {
          daemonStatus.textContent = "✅ Atlas daemon started and running";
        }
      } else if (
        installLog.includes("✗ Error:") &&
        installLog.lastIndexOf("✗ Error:") > installLog.lastIndexOf("Starting Atlas daemon...")
      ) {
        // Daemon step failed
        daemonStatus.textContent = "❌ Atlas daemon - start manually with 'atlas daemon start'";
        daemonStatus.style.color = "#e74c3c";
      }
    }
  }
}

// Initialize the installer when the page loads
document.addEventListener("DOMContentLoaded", () => {
  new AtlasInstaller();
});
