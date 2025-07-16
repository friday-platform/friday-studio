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
    document
      .getElementById("next-btn")
      .addEventListener("click", () => this.handleNext());

    document
      .getElementById("back-btn")
      .addEventListener("click", () => this.handleBack());

    document
      .getElementById("license-checkbox")
      .addEventListener("change", (e) => {
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
      eyeIcon.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.58838 11.351L2.46971 12.4697C2.17682 12.7626 2.17682 13.2374 2.46971 13.5303C2.76261 13.8232 3.23748 13.8232 3.53037 13.5303L4.85381 12.2069C5.74039 12.6822 6.7868 13 8.00004 13C11.3217 13 13.3928 10.6181 14.3572 9.14224C14.815 8.44183 14.815 7.55817 14.3572 6.85776C13.93 6.20404 13.2857 5.37253 12.4117 4.649L13.5304 3.53033C13.8233 3.23744 13.8233 2.76256 13.5304 2.46967C13.2375 2.17678 12.7626 2.17678 12.4697 2.46967L11.1463 3.79311C10.2597 3.31778 9.21328 3 8.00004 3C4.67841 3 2.6073 5.38195 1.64285 6.85776C1.18513 7.55817 1.18513 8.44183 1.64285 9.14224C2.07006 9.79596 2.7144 10.6275 3.58838 11.351ZM5.97768 11.083C6.5783 11.3414 7.25187 11.5 8.00004 11.5C10.5369 11.5 12.2161 9.67671 13.1016 8.32167C13.2335 8.1198 13.2335 7.8802 13.1016 7.67833C12.6899 7.04838 12.1067 6.31724 11.3456 5.71514L5.97768 11.083ZM10.0224 4.91698L4.65452 10.2849C3.89337 9.68276 3.31017 8.95162 2.8985 8.32167C2.76658 8.1198 2.76658 7.8802 2.8985 7.67833C3.78402 6.32329 5.46318 4.5 8.00004 4.5C8.74822 4.5 9.42179 4.65859 10.0224 4.91698Z" fill="black"/></svg>'; // Closed eye when showing
    } else {
      apiKeyInput.type = "password";
      eyeIcon.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.1015 8.32167C12.216 9.67671 10.5368 11.5 7.99998 11.5C5.46312 11.5 3.78396 9.67671 2.89844 8.32167C2.76652 8.1198 2.76652 7.8802 2.89844 7.67833C3.78396 6.32329 5.46312 4.5 7.99998 4.5C10.5368 4.5 12.216 6.32329 13.1015 7.67833C13.2334 7.8802 13.2334 8.1198 13.1015 8.32167ZM14.3572 6.85776C14.8149 7.55817 14.8149 8.44183 14.3572 9.14224C13.3927 10.6181 11.3216 13 7.99998 13C4.67835 13 2.60723 10.6181 1.64279 9.14224C1.18507 8.44183 1.18507 7.55817 1.64279 6.85776C2.60723 5.38195 4.67835 3 7.99998 3C11.3216 3 13.3927 5.38195 14.3572 6.85776ZM7.99998 10C9.10455 10 9.99998 9.10457 9.99998 8C9.99998 6.89543 9.10455 6 7.99998 6C6.89541 6 5.99998 6.89543 5.99998 8C5.99998 9.10457 6.89541 10 7.99998 10Z" fill="black"/></svg>'; // Open eye when hidden
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
    if (
      this.currentStep > 1 &&
      this.currentStep < this.totalSteps &&
      !this.isInstalling
    ) {
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
        action: () => globalThis.electronAPI.createAtlasDir(),
      },
      {
        progress: 40,
        message: "Installing Atlas binary...",
        action: () => globalThis.electronAPI.installAtlasBinary(),
      },
      {
        progress: 60,
        message: "Configuring API key...",
        action: () => this.configureApiKey(),
      },
      {
        progress: 80,
        message: "Setting up PATH...",
        action: () => globalThis.electronAPI.setupPath(),
      },
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
      return await globalThis.electronAPI.saveApiKey(apiKey.trim());
    } else {
      return {
        success: true,
        message: "API key skipped - no changes made to existing configuration",
      };
    }
  }

  updateInstallationUI(progress, log) {
    document.getElementById("progress-fill").style.width = `${progress}%`;
    document.getElementById(
      "progress-text",
    ).textContent = `${progress}% Complete`;
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
