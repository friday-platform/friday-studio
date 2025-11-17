const APP_URL = window.location.origin.replace("auth.", "app.");
let retryCount = 0;
const maxRetries = 40; // 40 retries * 3 seconds = 2 minutes

async function checkInstance() {
  try {
    const response = await fetch(`${APP_URL}/health`, { credentials: "include", mode: "cors" });

    if (response.ok) {
      // Instance is ready
      document.querySelector(".status").textContent = "Workspace ready! Redirecting...";
      setTimeout(() => {
        window.location.href = APP_URL;
      }, 500);
      return;
    } else if (response.status === 404 || response.status === 502) {
      // Instance not yet created or not ready
      document.querySelector(".status").textContent = "Creating your workspace...";
    }
  } catch (err) {
    // Network error, instance might not be ready
    console.log("Instance check failed:", err);
    document.querySelector(".status").textContent = "Setting up your workspace...";
  }

  retryCount++;
  if (retryCount >= maxRetries) {
    // Try redirecting anyway after 2 minutes
    window.location.href = APP_URL;
  } else {
    // Check again in 3 seconds
    setTimeout(checkInstance, 3000);
  }
}

// Start checking immediately
checkInstance();
