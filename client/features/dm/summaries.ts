/*
 * What a folded group of the DM panel says it holds
 * (docs/design/design-v1-panel-groups.md 6.2), so a phone that starts the
 * setup groups folded still reads the table at a glance. Table display's
 * is `displaysSummary` (tableDisplay.ts), beside its open line. Plain
 * functions, for node --test.
 */

const join = (parts: readonly (string | null)[]): string => parts.filter((p) => p !== null).join(" · ");

/** Handouts: how many show now. */
export function handoutsSummary(showing: number): string {
  return showing <= 0 ? "None showing" : `${showing} showing`;
}

/**
 * Players' screens: where the players are while the DM looks at another
 * scene, since Follow me and Bring everyone here then move nobody, then
 * Follow me, then a blackout while one lasts.
 */
export function screensSummary(input: { onPlayerScene: boolean; playerSceneName: string | null; follow: boolean; blackout: boolean }): string {
  return join([
    input.onPlayerScene ? null : input.playerSceneName ? `Players on ${input.playerSceneName}` : "Players on another scene",
    `Follow me ${input.follow ? "on" : "off"}`,
    input.blackout ? "Players see black" : null,
  ]);
}

/** Preview: Party sight while it veils the DM's map, else nothing, since View as a player keeps no state to say. */
export function checkSummary(partySight: boolean): string | undefined {
  return partySight ? "Party sight on" : undefined;
}
