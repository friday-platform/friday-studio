import { mount } from "svelte";
import App from "./App.svelte";

// Suppress the WKWebView/WebView2 right-click menu (Reload, Inspect Element,
// etc.). Reload throws away the install wizard's in-flight state — there's
// nothing in this app a user can usefully do from a context menu.
document.addEventListener("contextmenu", (e) => e.preventDefault());

// Drop the keyboard shortcuts that also restart the SPA — Cmd-R / Ctrl-R
// reload, Cmd-W close-tab, F5 reload — same reasoning as the context menu.
document.addEventListener("keydown", (e) => {
  if (
    (e.metaKey || e.ctrlKey) &&
    (e.key === "r" || e.key === "R" || e.key === "w" || e.key === "W")
  ) {
    e.preventDefault();
  }
  if (e.key === "F5") e.preventDefault();
});

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app element not found in index.html");
const app = mount(App, { target: appRoot });

export default app;
