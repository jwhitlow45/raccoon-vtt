/**
 * Copying on a page without a secure context (docs/design/design-v1-local-app.md 5).
 * The desktop app serves plain HTTP on the local network, where
 * `navigator.clipboard` is undefined and calling it throws.
 */

/** The words shown when neither way of copying worked and the text is selected for the person's own Copy. */
export const SELECTED_NOTE = "Selected. Use your device's Copy.";

export type CopyResult = "copied" | "selected";

export type CopyEnv = {
  clipboard: { writeText(text: string): Promise<void> } | undefined;
  /** Copies `text` through a selected off-screen textarea. Returns whether the browser said it worked. */
  execCopy(text: string): boolean;
  /** Selects the text the person can see, such as the link's own element. Returns whether anything was selected. */
  selectVisible(): boolean;
};

/**
 * Tries the async clipboard, then `execCommand("copy")`. When both fail it
 * selects the visible text, so the person can use their own Copy. The
 * third answer is false when there was nothing to select, a plain failure.
 */
export async function copyWith(env: CopyEnv, text: string, selectVisible?: () => boolean): Promise<CopyResult | "failed"> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return "copied";
    } catch {
      // Falls through: a denied permission is not the end of the ways to copy.
    }
  }
  try {
    if (env.execCopy(text)) return "copied";
  } catch {
    // Same: some browsers throw where others return false.
  }
  return (selectVisible ?? env.selectVisible)() ? "selected" : "failed";
}

function execCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  // Off-screen, not display:none, since a hidden field cannot be selected. 16px stops iOS zooming to it.
  area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } finally {
    area.remove();
    focused?.focus({ preventScroll: true });
  }
}

/**
 * Copies `text`. `visible` is the element showing it, selected when both
 * ways fail. "selected" means the caller should show `SELECTED_NOTE`.
 */
export function copyText(text: string, visible?: Element | null): Promise<CopyResult | "failed"> {
  const selectVisible = () => {
    if (!visible || typeof getSelection !== "function") return false;
    const selection = getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(visible);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  };
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  return copyWith({ clipboard, execCopy, selectVisible }, text);
}
