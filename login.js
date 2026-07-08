/* vdkify — login / first-run setup */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const savedTheme = localStorage.getItem("vdkify-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = savedTheme || (prefersDark ? "dark" : "light");

  let mode = "login";

  fetch("api/status", { cache: "no-store" })
    .then((r) => r.json())
    .then((s) => {
      mode = s.needsSetup ? "setup" : "login";
      $("#pass-field").hidden = false;
      $("#login-submit").hidden = false;
      if (mode === "setup") {
        $("#login-sub").textContent = "set the admin password to get started";
        $("#pass-label").textContent = "Admin password (10+ characters)";
        $("#login-pass").autocomplete = "new-password";
        $("#login-pass").minLength = 10;
        $("#pass2-field").hidden = false;
        $("#login-pass2").required = true;
        $("#login-submit").textContent = "Set password & enter";
      } else {
        $("#login-sub").textContent = "sign in to your deploy dashboard";
      }
      $("#login-pass").focus();
    })
    .catch(() => {
      $("#login-error").textContent = "Can't reach the server — start it with:  node server.js";
    });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#login-error");
    const pass = $("#login-pass").value;
    if (mode === "setup" && pass !== $("#login-pass2").value) {
      err.textContent = "Passwords don't match.";
      return;
    }
    const btn = $("#login-submit");
    btn.disabled = true;
    let res, data;
    try {
      res = await fetch(mode === "setup" ? "api/setup" : "api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pass })
      });
      data = await res.json();
    } catch {
      err.textContent = "Can't reach the server.";
      btn.disabled = false;
      return;
    }
    if (res.ok && data.token) {
      localStorage.setItem("vdkify-token", data.token);
      location.replace("index.html");
    } else {
      err.textContent = data.error || "Sign-in failed.";
      $("#login-pass").value = "";
      $("#login-pass").focus();
      btn.disabled = false;
    }
  });
})();
