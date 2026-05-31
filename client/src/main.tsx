import { createRoot } from "react-dom/client";
import App from "./App";
import { normalizeHashRouteSearch } from "./lib/hashRouteSearch";
import { installTauriExternalLinkHandler } from "./lib/tauri";
import "./index.css";

installTauriExternalLinkHandler();

// wouter's hash router expects the path in location.hash and the query in
// location.search. Normalize deep links like #/logs?level=info before mount.
{
  const normalizedHref = normalizeHashRouteSearch(window.location.href);
  if (normalizedHref) {
    history.replaceState(history.state, "", normalizedHref);
  }
}

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);
