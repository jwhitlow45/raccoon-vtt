import type { CSSProperties } from "react";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";

/** A card in the fight alerts column, as the concentration card there looks. */
export const cardStyle: CSSProperties = {
  pointerEvents: "auto",
  padding: `${theme.space(2)}px ${theme.space(3)}px`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceRaised,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  color: theme.color.text,
  boxShadow: theme.shadow.float,
};

/** Pass or Fail as a word in its tone, never color alone, or "Mark it" while a roll with no DC waits for the DM. */
export function ResultBadge(props: { result: "pass" | "fail" | undefined; wantsMark?: boolean }) {
  if (props.result === undefined && !props.wantsMark) return null;
  const tone = props.result === "pass" ? "success" : props.result === "fail" ? "danger" : "warning";
  const text = props.result === "pass" ? "Pass" : props.result === "fail" ? "Fail" : "Mark it";
  return (
    <Tag tone={tone} dense>
      {text}
    </Tag>
  );
}

/**
 * Whether an element can take focus now: on the page and drawn, so not
 * folded under a `hidden` ancestor (a sheet's dock folds the alerts
 * column), where focus() would do nothing.
 */
export function focusable(el: HTMLElement | null): el is HTMLElement {
  return el !== null && el.isConnected && el.getClientRects().length > 0 && el.closest("[hidden]") === null;
}
