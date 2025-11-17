document.getElementById("login-form").addEventListener("submit", async (e) => {
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
        <p>We've sent a magic link to <strong>${email}</strong></p>
        <p>Click the link in the email to sign in.</p>
        <a href="/login" class="back-link">Back to login</a>
      `;
    } else {
      const data = await response.json();
      errorDiv.textContent = data.error || "Failed to send login email";
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

document.getElementById("google-login-btn").addEventListener("click", () => {
  window.location.href = "/oauth/google";
});
