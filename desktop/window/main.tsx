import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startInputModality } from "../../client/lib/inputModality.ts";
import { themeChoiceSetting } from "../../client/features/device/settings.ts";
import { startScheme } from "../../client/lib/scheme.ts";
import "../../client/globals.css";
import { App } from "./App.tsx";

// The page follows the system's light or dark theme through the app's own scheme code, before the first render.
// Auto for this page only: the web app keeps its default (Dark) and never stores a choice here.
themeChoiceSetting.apply("auto");
startInputModality();
startScheme();

/**
 * The shell's preload puts the real bridge on `window.raccoonLocal`. Where
 * there is none (development in a browser, desktop/e2e/window.e2e.ts), the
 * fake stands in, loaded only then, with the state `?scenario=` names.
 */
async function bridge() {
  if (window.raccoonLocal) return window.raccoonLocal;
  const { fakeFromLocation } = await import("./fakeBridge.ts");
  const fake = fakeFromLocation(location.search);
  window.fakeBridge = fake;
  return fake.bridge;
}

void bridge().then((b) =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App bridge={b} />
    </StrictMode>,
  ),
);
