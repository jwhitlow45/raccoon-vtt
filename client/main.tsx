import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startInputModality } from "./lib/inputModality.ts";
import { captureLinkPassword } from "./lib/playerLink.ts";
import { startScheme } from "./lib/scheme.ts";
import "./globals.css";

// A player link's password leaves the address bar before the app renders
// (design section 10.2). A link opened into a page that is already showing
// changes only the hash, so the same check runs on hashchange and popstate.
// These listeners are added before the router's, so it never sees the
// password either.
const capture = () => captureLinkPassword(location, (url) => history.replaceState(history.state, "", url));
capture();
window.addEventListener("hashchange", capture);
window.addEventListener("popstate", capture);

startInputModality();

// The device's Theme colors the page before the first render, so a light
// device never paints one frame of the dark app (lib/scheme.ts).
startScheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
