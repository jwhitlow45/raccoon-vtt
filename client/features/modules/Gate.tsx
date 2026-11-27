import { Children, cloneElement, isValidElement, useEffect, useMemo, type ReactElement, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { readKnownRooms } from "../../lib/knownRooms.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope, type RoomScope } from "../../state/scope.ts";
import { INITIAL_LOCAL, type LocalUi } from "../../state/types.ts";
import { useRoomStore, useRoomUi, useRoomYouIfAny, type RoomUi } from "../../state/view.ts";
import { BUILD_MODES, builderSlot, pickBuildMode } from "../builder/store.ts";
import { groupSaveSlot } from "../dice/groupSave/store.ts";
import { usePreview } from "../dm/previewContext.ts";
import { claimShown, EVERYTHING, hiddenAt, hiddenModules, moduleShown, showLabel, toolShown } from "./gate.ts";
import type { Holder, Home, ModuleId, Role } from "./registry.ts";
import { showModule, useFeatureChoices, type FeatureChoices } from "./store.ts";

/**
 * The parts gate for components (docs/design/design-v1-features.md 8): the
 * hooks and components that read this device's choices on a Room page.
 * The pure rules live in gate.ts.
 */

/**
 * The role whose choices hold on this page, and the choices. Every part
 * shows outside a room, in a "view as a player" preview and on a table
 * display (D-261127-126), and while the role is unknown. Before the room
 * says who you are, the role this device last had in the room stands in
 * (lib/knownRooms.ts), so a DM's hidden parts never flash (D-261127-316).
 */
export function useFeaturesHere(): { role: Role | null; choices: FeatureChoices } {
  const room = useRoomYouIfAny();
  const preview = usePreview() !== null;
  const stored = useFeatureChoices();
  const roomId = room?.roomId ?? null;
  const known = useMemo(() => (roomId === null ? null : (readKnownRooms().find((r) => r.roomId === roomId)?.role ?? null)), [roomId]);
  const role = room ? (room.role ?? known) : null;
  if (!room || room.display || preview || role === null) return { role, choices: EVERYTHING };
  return { role, choices: stored };
}

/** The choices that hold on this page, EVERYTHING where every part shows, for a caller that has its role already, as the canvas's `activeTool`. */
export function useFeatureChoicesHere(): FeatureChoices {
  return useFeaturesHere().choices;
}

/** Whether a part shows on this page. Call it on every render, never inside a condition (D-261127-392). */
export function useModule(id: ModuleId): boolean {
  const { role, choices } = useFeaturesHere();
  return role === null || moduleShown(id, role, choices);
}

function marked(id: ModuleId, children: ReactNode): ReactNode {
  const only = Children.toArray(children);
  const child = only[0];
  if (only.length === 1 && isValidElement(child) && typeof child.type === "string") return cloneElement(child as ReactElement<Record<string, unknown>>, { "data-part": id });
  return (
    <div data-part={id} style={{ display: "contents" }}>
      {children}
    </div>
  );
}

/**
 * A surface of a part: drawn while the part shows, and marked with
 * `data-part` for the markup test and the e2e probes, on its child when
 * that child is one DOM element, else on a `display: contents` wrapper
 * (D-261127-424). A gated component that is not a DOM element spreads
 * `partMark(id)` on its own root instead. `when` is a claim's named
 * condition as the caller knows it, such as Floors' one-floor scene: the
 * surface hides only while it holds.
 */
export function Module(props: { id: ModuleId; when?: boolean; children?: ReactNode }): ReactNode {
  const shown = useModule(props.id);
  if (!shown && props.when !== false) return null;
  return marked(props.id, props.children);
}

export type HiddenPart = { id: ModuleId; name: string; label: string; show(): void };

/** The parts hidden at a home for this page's role, each with its Show, which turns on what it needs too (D-261127-308). */
export function useHiddenHere(home: Home, holder?: Holder): HiddenPart[] {
  const { role, choices } = useFeaturesHere();
  if (role === null) return [];
  return hiddenAt(home, role, choices, holder).map((m) => ({ id: m.id, name: m.name, label: showLabel(m.id, role, choices), show: () => showModule(m.id, role) }));
}

/**
 * A way back where the parts lived (design section 6): "Hidden on this
 * device:" and a quiet Show button per part, nothing while none are hidden.
 * On a creature's surface pass `holder`, so only the parts that creature
 * holds are named (D-261127-391).
 */
export function HiddenHere(props: { home: Home; holder?: Holder }): ReactNode {
  const parts = useHiddenHere(props.home, props.holder);
  if (parts.length === 0) return null;
  return (
    <div role="group" aria-label="Hidden on this device" data-hidden-here={props.home} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2) }}>
      <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>Hidden on this device:</span>
      {parts.map((p) => (
        <Button key={p.id} size="sm" variant="quiet" onClick={p.show}>
          {p.label}
        </Button>
      ))}
    </div>
  );
}

/** The side panel's default tab, where a hidden part's tab closes to. */
const DEFAULT_TAB = INITIAL_LOCAL.tab;

/** What ending a hidden part's work reads and changes: the room's local state and its setters, and the Room page's scope. */
export type HiddenGuardRoom = {
  local(): LocalUi;
  ui: Pick<RoomUi, "setTool" | "openPanel" | "splitPanels" | "closePanel">;
  scope: RoomScope;
};

/**
 * Ends what a hidden part was doing on this page (design section 5, Effect,
 * and 8, D-261127-130, 302, 393): an active tool of a hidden part goes back
 * to Select, where the canvas's activation effect then cancels its gesture
 * and runs its `deactivate`, the builder leaves Add a wing for its first
 * mode, an Areas group save moves to Dice whole, and an open panel of a
 * hidden part closes, a tab to the default tab and a phone's sheet for
 * good. Stored tab rows, splits, views and keys stay as they are.
 */
export function endHidden(room: HiddenGuardRoom, role: Role, choices: FeatureChoices, wide: boolean): void {
  const { ui, scope } = room;
  const start = room.local();
  if (!toolShown(start.tool, role, choices, start.toolBorrowed === true)) ui.setTool("select");
  if (!moduleShown("dungeon", role, choices) && scope.get(builderSlot).store.getState().mode === "wing") pickBuildMode(scope, BUILD_MODES[0]!.value, choices);
  const shown = (id: string) => claimShown("panel", id, role, choices);
  // Closing an open group save would lose a game-affecting page, so it moves to Dice where Areas stood, with its page, requests, answers and draft.
  const save = scope.get(groupSaveSlot);
  if (!shown("areas") && save.getState().shownIn === "areas") {
    save.setState({ shownIn: "dice" });
    const at = room.local();
    if (wide ? at.tab === "areas" : at.panel === "areas") ui.openPanel("dice", wide ? { pane: "top" } : undefined);
    else if (wide && at.below === "areas") ui.openPanel("dice", { pane: "below" });
  }
  if (wide) {
    if (!shown(room.local().tab)) ui.openPanel(DEFAULT_TAB, { pane: "top" });
    const below = room.local().below;
    if (below !== null && !shown(below)) ui.splitPanels(false);
  } else {
    const panel = room.local().panel;
    if (panel !== null && !shown(panel)) ui.closePanel();
  }
}

/**
 * Room's part when a part hides, here or from another window (endHidden).
 * It runs when the hidden parts change, never on every render, so a link
 * that opened a hidden panel once (D-261127-129) keeps it until the viewer
 * leaves it.
 */
export function useHiddenGuard(wide: boolean): void {
  const { role, choices } = useFeaturesHere();
  const store = useRoomStore();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const hidden = role === null ? null : hiddenModules(role, choices);
  const key = hidden ? [...hidden].join(" ") : "";
  useEffect(() => {
    if (role === null || key === "") return;
    endHidden({ local: () => store.getState().local, ui, scope }, role, choices, wide);
    // `key` stands for `choices`: a new choices object with the same parts hidden changes nothing.
  }, [key, wide, role, store, ui, scope]);
}
