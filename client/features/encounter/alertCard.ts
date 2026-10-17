import type { CSSProperties } from "react";
import { theme } from "../../lib/theme.ts";

/** One card of the fight alerts column (InitiativeStrip.tsx FightAlerts), shared by every kind so they stack alike. */
export const alertCard: CSSProperties = {
  pointerEvents: "auto",
  padding: `${theme.space(2)}px ${theme.space(3)}px`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceRaised,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  color: theme.color.text,
  boxShadow: theme.shadow.float,
};
