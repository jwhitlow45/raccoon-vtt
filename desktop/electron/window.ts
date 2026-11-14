import { readFile } from "node:fs/promises";
import { BrowserWindow, app, nativeTheme, protocol, session, shell, type WebContents } from "electron";
import { PALETTES } from "../../client/lib/theme.ts";
import { APP_NAME, type Platform } from "../contract.ts";
import { APP_ORIGIN, APP_SCHEME, WINDOW_CSP, WINDOW_URL, contentType, externalAllowed, windowFile } from "../shell/navigation.ts";
import { zoomKey, zoomStep } from "../shell/zoom.ts";

/**
 * Must run before the app is ready. `standard` gives the page normal
 * relative URLs and an origin, and `secure` makes it a secure context, so
 * the page behaves as one served over HTTPS would.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Serves the window's Vite build at `app://raccoonvtt/`, every answer carrying the window's policy (design 6.4). */
export function serveWindow(root: string): void {
  const headers = { "content-security-policy": WINDOW_CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" };
  protocol.handle(APP_SCHEME, async (request) => {
    const file = request.method === "GET" ? windowFile(request.url, root) : null;
    if (file) {
      try {
        const body = await readFile(file);
        return new Response(new Uint8Array(body), { headers: { ...headers, "content-type": contentType(file) } });
      } catch {
        // Not in the build: answer as any other missing file.
      }
    }
    return new Response("Not found", { status: 404, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  });
}

/**
 * Rules for every page Electron ever makes (design 6.4): nothing navigates
 * away or opens a window, only the app on this computer's port and the
 * release pages open, in the default browser, and no permission (camera,
 * notifications, clipboard reads) is ever granted. The window copies
 * through the shell instead.
 */
export function lockDown(currentPort: () => number | null, platform: Platform): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on("web-contents-created", (_event, contents) => {
    const openOutside = (url: string) => {
      if (externalAllowed(url, currentPort())) void shell.openExternal(url);
    };
    contents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      event.preventDefault();
      openOutside(url);
    });
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    zoomWithin(contents, platform);
  });
}

/**
 * Zoom by the keys a browser uses and by Ctrl or Cmd with the wheel, only
 * in the steps from 100% to 150% (design 9). Pinch zoom would scale the page
 * past what its layout was measured at, so it is off.
 */
function zoomWithin(contents: WebContents, platform: Platform): void {
  void contents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  contents.on("before-input-event", (event, input) => {
    const direction = zoomKey(input, platform);
    if (direction === null) return;
    event.preventDefault();
    contents.setZoomFactor(zoomStep(contents.getZoomFactor(), direction));
  });
  contents.on("zoom-changed", (_event, direction) => {
    contents.setZoomFactor(zoomStep(contents.getZoomFactor(), direction === "in" ? 1 : -1));
  });
}

/**
 * The window (design 9): 440 x 720 to start, never under 400 x 560,
 * following the system's theme. Its first paint is the page's own
 * background, so it never flashes white in dark mode.
 */
export function createWindow(preload: string, icon: string | undefined): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 400,
    minHeight: 560,
    // The page gets exactly these sizes, the ones its layout is measured at.
    useContentSize: true,
    title: APP_NAME,
    show: false,
    icon,
    autoHideMenuBar: true,
    backgroundColor: PALETTES[nativeTheme.shouldUseDarkColors ? "dark" : "light"].bg,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.once("ready-to-show", () => win.show());
  void win.loadURL(WINDOW_URL);
  return win;
}

/** Whether an IPC message came from the window's own page. */
export function fromWindow(win: BrowserWindow | null, sender: WebContents, frameUrl: string | undefined): boolean {
  if (!win || win.isDestroyed() || sender !== win.webContents) return false;
  return typeof frameUrl === "string" && (frameUrl === APP_ORIGIN || frameUrl.startsWith(`${APP_ORIGIN}/`));
}
