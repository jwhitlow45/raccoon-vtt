import type { MouseEvent, ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { Button } from "./Button.tsx";

/**
 * Try again where a second request can succeed, or a reload (ReloadButton
 * in LoadBoundary.tsx) where only a reload can, as for code.
 *
 * Try again leaves as it is pressed, its line giving way to the loading
 * line, so `focusTo` names what takes focus from it: a control or a
 * section that stays, found from the button. Otherwise focus would fall to
 * the page, and a keyboard or screen reader user would have to find the
 * place again.
 */
export type LoadFailedAction =
  | { retry(): void; focusTo?(from: HTMLElement): HTMLElement | null | undefined; reload?: never }
  | { reload: ReactNode; retry?: never; focusTo?: never };

/**
 * A load that failed beside what still works (docs/design-v1-look-pass.md
 * 2.9): one muted line, an alert, that says what failed and what still
 * shows, with its one way out at the right. It wraps under the words only
 * where the line cannot hold both. Every such line looks the same, so a
 * failure in a list reads as a state of that list rather than as a broken
 * screen. A failure that takes a whole panel's place is that panel's
 * notice instead (LoadFailureNotice, or SrdLoadFailed's danger Notice).
 */
export function LoadFailed(props: { children: ReactNode } & LoadFailedAction) {
  const { retry, focusTo } = props;
  const onRetry = (e: MouseEvent<HTMLButtonElement>) => {
    const from = e.currentTarget;
    if (from === document.activeElement) focusTo?.(from)?.focus({ preventScroll: true });
    retry?.();
  };
  return (
    <div
      role="alert"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), color: theme.color.textMuted, fontSize: theme.font.body14, lineHeight: theme.leading.body }}
    >
      <span style={{ flex: "1 1 160px", minWidth: 0 }}>{props.children}</span>
      {retry ? (
        <Button icon="retry" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : (
        <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>{props.reload}</div>
      )}
    </div>
  );
}
