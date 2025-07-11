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
      this.platformInfo = await window.electronAPI.getPlatform();
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
      this.handleApiKeyInput(e.target.value);
    });

    document.getElementById("show-hide-btn").addEventListener("click", () => {
      this.toggleApiKeyVisibility();
    });
  }

  loadLicenseText() {
    const licenseText = `End-User License Agreement (EULA) for Atlas

IMPORTANT - READ CAREFULLY

This End-User License Agreement ("Agreement") is a legal agreement between you (either an individual or a single entity, hereinafter "You" or "Licensee") and Tempest Labs, Inc. ("Licensor") for the software product named Atlas, including any associated media, printed materials, and "online" or electronic documentation (collectively, the "Software").

By installing, copying, or otherwise using the Software, you agree to be bound by the terms of this Agreement. If you do not agree to the terms of this Agreement, do not install or use the Software.

1. Definitions

"Software" refers to the CLI tool "Atlas" and all related files and documentation provided by Tempest Labs, Inc.

"Internal Use" means the use of the Software by the Licensee's employees or authorized contractors for the Licensee's own internal business purposes. It explicitly excludes use for the benefit of any third party or for any commercial purpose.

"Commercial Use" means any use of the Software for direct or indirect financial gain, including but not limited to, embedding it in a commercial product, using it to provide paid services, or distributing it for a fee.

2. Grant of License

Subject to the terms and conditions of this Agreement, Tempest Labs, Inc. hereby grants you a non-exclusive, non-transferable, non-sublicensable, revocable license to install and use the Software on devices owned or controlled by you, solely for your Internal Use.

3. License Restrictions

You may not, and shall not permit any third party to, do any of the following:

(a) Commercial Use: Use the Software for any Commercial Use.
(b) Reverse Engineering: Reverse engineer, decompile, disassemble, or otherwise attempt to discover the source code or underlying ideas or algorithms of the Software.
(c) Modification: Modify, translate, or create derivative works based on the Software.
(d) Redistribution: Sell, rent, lease, lend, redistribute, or sublicense the Software to any third party.
(e) Proprietary Notices: Remove, alter, or obscure any proprietary notices (including copyright and trademark notices) of Tempest Labs, Inc. or its suppliers on the Software.
(f) Competitive Use: Use the Software to develop a competing product or service.

4. Intellectual Property Ownership

The Software is licensed, not sold. Tempest Labs, Inc. and its licensors retain all right, title, and interest in and to the Software, including all copyrights, patents, trade secrets, trademarks, and other intellectual property rights.

5. Termination

This Agreement is effective until terminated. Your rights under this license will terminate automatically without notice from Tempest Labs, Inc. if you fail to comply with any term(s) of this Agreement.

6. Disclaimer of Warranties

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITH ALL FAULTS AND WITHOUT WARRANTY OF ANY KIND.

7. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL TEMPEST LABS, INC. BE LIABLE FOR ANY INCIDENTAL, SPECIAL, INDIRECT, OR CONSEQUENTIAL DAMAGES WHATSOEVER.

8. Governing Law and Jurisdiction

This Agreement will be governed by and construed in accordance with the laws of the State of Delaware.

BY USING THE SOFTWARE, YOU ACKNOWLEDGE THAT YOU HAVE READ THIS AGREEMENT, UNDERSTAND IT, AND AGREE TO BE BOUND BY ITS TERMS AND CONDITIONS.`;

    document.getElementById("license-text").textContent = licenseText;
  }

  validateApiKey(apiKey) {
    // Empty is valid (skip case)
    if (!apiKey || apiKey.trim() === "") return true;

    // Non-empty must match pattern
    const pattern = /^sk-ant-[a-z0-9]+-[A-Za-z0-9_-]+$/;
    return pattern.test(apiKey.trim());
  }

  isApiKeyValid() {
    const apiKey = document.getElementById("api-key").value;
    return this.validateApiKey(apiKey);
  }

  toggleApiKeyVisibility() {
    const apiKeyInput = document.getElementById("api-key");
    const eyeIcon = document.getElementById("eye-icon");

    if (apiKeyInput.type === "password") {
      apiKeyInput.type = "text";
      eyeIcon.textContent = "🙈"; // Closed eye when showing
    } else {
      apiKeyInput.type = "password";
      eyeIcon.textContent = "👁️"; // Open eye when hidden
    }
  }

  handleApiKeyInput(value) {
    const validationEl = document.getElementById("api-key-validation");

    if (!value || value.trim() === "") {
      // Empty is valid (skip case)
      validationEl.classList.add("hidden");
    } else if (this.validateApiKey(value)) {
      // Valid API key format
      validationEl.classList.add("hidden");
    } else {
      // Invalid API key format - show error and prevent continue
      validationEl.textContent =
        'Invalid API key format. Must start with "sk-ant-" followed by valid characters.';
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
    if (this.currentStep > 0 && this.currentStep < this.totalSteps && !this.isInstalling) {
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

      case 1: // License
        const licenseAccepted = document.getElementById("license-checkbox").checked;
        nextBtn.textContent = "Agree & Continue";
        nextBtn.disabled = !licenseAccepted;
        nextBtn.className = "btn btn-primary";
        break;

      case 2: // API Key
        const isApiKeyValid = this.isApiKeyValid();
        nextBtn.textContent = "Continue";
        nextBtn.disabled = !isApiKeyValid;
        nextBtn.className = "btn btn-primary";
        break;

      case 3: // Installation
        if (this.isInstalling) {
          nextBtn.classList.add("hidden");
        } else {
          nextBtn.classList.remove("hidden");
          nextBtn.textContent = "Install";
          nextBtn.disabled = false;
          nextBtn.className = "btn btn-success";
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
        await window.electronAPI.quitApp();
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
    const apiKey = document.getElementById("api-key").value;
    const apiKeyItem = document.getElementById("api-key-item");

    if (apiKey.trim()) {
      apiKeyItem.classList.remove("hidden");
    } else {
      apiKeyItem.classList.add("hidden");
    }
  }

  async startInstallation() {
    this.isInstalling = true;
    this.updateNextButton();

    // Show progress UI
    document.getElementById("install-title").textContent = "Installing Atlas...";
    document.getElementById("install-description").textContent =
      "Please wait while Atlas is being installed.";
    document.getElementById("install-summary").classList.add("hidden");
    document.getElementById("progress-container").classList.remove("hidden");

    const steps = [
      {
        progress: 20,
        message: "Creating Atlas directory...",
        action: () => window.electronAPI.createAtlasDir(),
      },
      {
        progress: 40,
        message: "Installing Atlas binary...",
        action: () => window.electronAPI.installAtlasBinary(),
      },
      { progress: 60, message: "Configuring API key...", action: () => this.configureApiKey() },
      { progress: 80, message: "Setting up PATH...", action: () => window.electronAPI.setupPath() },
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
          log += `✓ ${step.message.replace("...", " completed")}\n`;
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
      this.updateStepIndicator();
    }, 1000);
  }

  async configureApiKey() {
    const apiKey = document.getElementById("api-key").value;

    if (apiKey && apiKey.trim() && this.validateApiKey(apiKey)) {
      return await window.electronAPI.saveApiKey(apiKey.trim());
    } else {
      return {
        success: true,
        message: "API key skipped - no changes made to existing configuration",
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
}

// Initialize the installer when the page loads
document.addEventListener("DOMContentLoaded", () => {
  new AtlasInstaller();
});
