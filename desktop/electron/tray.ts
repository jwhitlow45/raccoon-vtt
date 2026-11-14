import { join } from "node:path";
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import { APP_NAME, type Platform } from "../contract.ts";
import type { TrayItem, TrayItemId } from "../shell/tray.ts";

export type TrayHandlers = {
  openWindow(): void;
  openBrowser(): void;
  setNetworkPlay(on: boolean): void;
  quit(): void;
};

/**
 * The menu bar on macOS takes a black template image that the system tints
 * for light and dark bars. Windows and Linux show the icon in color. Each
 * comes with an @2x file for high-density screens, which nativeImage picks
 * up by name.
 */
function trayImage(iconDir: string, platform: Platform): Electron.NativeImage {
  if (platform === "darwin") {
    const image = nativeImage.createFromPath(join(iconDir, "trayTemplate.png"));
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage.createFromPath(join(iconDir, "tray.png"));
}

/** The notification area, menu bar or AppIndicator icon (design 9). */
export class ShellTray {
  readonly #tray: Tray;
  readonly #handlers: TrayHandlers;
  #menu: Menu | null = null;

  constructor(iconDir: string, platform: Platform, handlers: TrayHandlers) {
    this.#handlers = handlers;
    this.#tray = new Tray(trayImage(iconDir, platform));
    this.#tray.setToolTip(APP_NAME);
    // A click on Windows' icon opens the window, as a double click on most
    // tray apps does. macOS opens the menu on click, and Linux's
    // AppIndicator sends no click at all.
    if (platform === "win32") this.#tray.on("click", () => handlers.openWindow());
  }

  /** The menu as it is now, for the e2e test to read and click. */
  get menu(): Menu | null {
    return this.#menu;
  }

  update(items: readonly TrayItem[]): void {
    this.#menu = Menu.buildFromTemplate(items.map((item) => this.#option(item)));
    this.#tray.setContextMenu(this.#menu);
  }

  destroy(): void {
    if (!this.#tray.isDestroyed()) this.#tray.destroy();
  }

  #option(item: TrayItem): MenuItemConstructorOptions {
    if (item.type === "separator") return { type: "separator" };
    const id: TrayItemId = item.id;
    if (item.type === "checkbox") {
      return {
        id,
        type: "checkbox",
        label: item.label,
        enabled: item.enabled,
        checked: item.checked,
        // Electron flips `checked` before the click arrives, so it holds the
        // value the DM asked for. The next status redraws the menu from the
        // setting either way.
        click: (menuItem) => this.#handlers.setNetworkPlay(menuItem.checked),
      };
    }
    const actions: Record<Exclude<TrayItemId, "networkPlay">, () => void> = {
      openWindow: () => this.#handlers.openWindow(),
      openBrowser: () => this.#handlers.openBrowser(),
      quit: () => this.#handlers.quit(),
    };
    return { id, label: item.label, enabled: item.enabled, click: id === "networkPlay" ? undefined : actions[id] };
  }
}
