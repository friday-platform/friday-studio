document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("email").value;
  const submitBtn = document.getElementById("submit-btn");
  const errorDiv = document.getElementById("error-message");

  submitBtn.disabled = true;
  submitBtn.querySelector(".btn-text").style.display = "none";
  submitBtn.querySelector(".btn-loading").style.display = "inline";
  errorDiv.style.display = "none";

  try {
    const response = await fetch("/signup/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      credentials: "include",
    });

    if (response.ok) {
      document.querySelector(".auth-container").innerHTML = `
        <h1>Check your email</h1>
        <p>We've sent a confirmation email to <strong>${email}</strong></p>
        <p>Click the link in the email to confirm your account.</p>
        <a href="/signup" class="back-link">Back to signup</a>
      `;
    } else {
      const data = await response.json();
      errorDiv.textContent = data.error || "Failed to send signup email";
      errorDiv.style.display = "block";
    }
  } catch (err) {
    errorDiv.textContent = "Network error. Please try again.";
    errorDiv.style.display = "block";
  } finally {
    submitBtn.disabled = false;
    submitBtn.querySelector(".btn-text").style.display = "inline";
    submitBtn.querySelector(".btn-loading").style.display = "none";
  }
});

document.getElementById("google-signup-btn").addEventListener("click", () => {
  window.location.href = "/oauth/google";
});
