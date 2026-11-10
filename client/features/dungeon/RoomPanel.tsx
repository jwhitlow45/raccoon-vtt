import { useEffect, useId, useRef, type ReactNode } from "react";
import { trapPreset } from "#shared/srd/traps.ts";
import { Button } from "../../components/Button.tsx";
import { Held } from "../../components/Held.tsx";
import { Help } from "../../components/Panel.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { Choice } from "./Choices.tsx";
import { SECRET_OFF, type DoorFacts, type DoorPin, type RoomEdit, type RoomFacts } from "./edits.ts";
import { CHOICE_NAMES, DRESSINGS, type Dressing } from "./settings.ts";
import { doorName, ENTRANCE_FLAT, HEIGHT_HELP, NO_TRAP_FITS, reportsByRow, ROOM_GONE, roomTitle, WING_FLAT } from "./words.ts";

/*
 * The room panel (docs/design: dungeon generator phase 3, 4.1, D-261110-097
 * and 171), shared by the Generate a dungeon dialog and the wing pane: one
 * room's height, doors, trap, dressing and light, set as pins its owner
 * keeps. It takes the choices' place, so it holds no state of its own
 * beyond focus: the owner keeps the edits, plans again with them and hands
 * back the room's facts, reports included.
 */

/** The heights a room may be pinned to, in feet, sunk first. */
export const ROOM_HEIGHTS: readonly { value: number; label: string }[] = [
  { value: -10, label: "Sunk 10 ft" },
  { value: -5, label: "Sunk 5 ft" },
  { value: 0, label: "Flat" },
  { value: 5, label: "Raised 5 ft" },
  { value: 10, label: "Raised 10 ft" },
];

const NO_TRAP = "none";

export type RoomPanelProps = {
  /** The room as the plan on screen made it, or null when the room the DM picked is gone from it. */
  facts: RoomFacts | null;
  /** This room's pins, or none. */
  edit: RoomEdit | undefined;
  /** The room's pins after a change, or null to drop them all (Reset room). */
  onEdit(next: RoomEdit | null): void;
  /** ‹ and ›: the room before or after this one in number order. */
  onStep(by: -1 | 1): void;
  /** Done: back to the choices, focus to what opened the panel. */
  onDone(): void;
  /** Caves have no doors. */
  cave: boolean;
  /** A wing on a scene whose stairs make no walls stays flat (3.2). */
  flat?: boolean;
  /** Held while the owner sends. */
  held?: boolean;
  /** Reports the owner adds beside the plan's own, such as an edit undone for the wall budget. */
  more?: readonly string[];
};

export function RoomPanel(props: RoomPanelProps) {
  const { facts, edit } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const room = facts?.room ?? null;
  // Focus moves to the heading as the panel opens and as ‹ or › brings another room (7).
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [room]);

  const title = facts ? roomTitle(facts.n) : ROOM_GONE.title;
  const reports = [...(facts?.reports ?? []), ...(props.more ?? [])];
  const rows = reportsByRow(reports);
  const set = (patch: RoomEdit) => props.onEdit({ ...(edit ?? {}), ...patch });
  const edited = edit !== undefined && Object.keys(edit).length > 0;

  return (
    <section role="region" aria-labelledby={headingId} data-room-panel="" style={{ display: "grid", gap: theme.space(4), minWidth: 0, alignContent: "start" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <h3 ref={headingRef} id={headingId} tabIndex={-1} style={{ margin: 0, flex: "1 1 auto", fontSize: theme.font.input, fontWeight: theme.weight.strong, outline: "none" }}>
          {title}
        </h3>
        <div style={{ display: "flex", gap: theme.space(2) }}>
          <Button size="sm" aria-label="Previous room" title="Previous room" onClick={() => props.onStep(-1)}>
            ‹
          </Button>
          <Button size="sm" aria-label="Next room" title="Next room" onClick={() => props.onStep(1)}>
            ›
          </Button>
          <Button size="sm" variant="primary" onClick={props.onDone}>
            Done
          </Button>
        </div>
      </div>
      {/* Reports are spoken once, as they come with the next plan (7). */}
      <div role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
        {reports.join(" ")}
      </div>
      {facts ? (
        <Held held={props.held === true} style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
          <HeightRow facts={facts} edit={edit} flat={props.flat === true} onChange={(ground) => set({ ground })} reports={rows.height} />
          <DoorRows facts={facts} edit={edit} cave={props.cave} onChange={(key, pin) => set({ doors: { ...(edit?.doors ?? {}), [key]: pin } })} reports={rows.doors} />
          <TrapRow facts={facts} edit={edit} onChange={(trap) => set({ trap })} reports={rows.trap} />
          <Choice<Dressing>
            name="Dressing"
            value={edit?.dressing ?? facts.dressing}
            onChange={(dressing) => set({ dressing })}
            options={DRESSINGS.map((v) => ({ value: v, label: CHOICE_NAMES.dressing[v] }))}
          >
            <div>
              {/* Each tap draws the room's props again from its own next stream, so no other room changes (4.3). */}
              <Button size="sm" disabled={(edit?.dressing ?? facts.dressing) === "none"} onClick={() => set({ propsDraw: ((edit?.propsDraw ?? 0) + 1) % 16, dressing: edit?.dressing ?? facts.dressing })}>
                Other props
              </Button>
            </div>
            <Reports lines={rows.dressing} />
          </Choice>
          <Choice<"off" | "on">
            name="Lit"
            value={(edit?.lit ?? facts.lit) ? "on" : "off"}
            onChange={(v) => set({ lit: v === "on" })}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
          >
            <Reports lines={rows.lit} />
          </Choice>
          <Reports lines={rows.other} />
          <div>
            <Button size="sm" disabled={!edited} onClick={() => props.onEdit(null)}>
              Reset room
            </Button>
          </div>
        </Held>
      ) : (
        <div style={{ display: "grid", gap: theme.space(2), justifyItems: "start" }}>
          <Help>{ROOM_GONE.line}</Help>
          <Button size="sm" disabled={!edited || props.held === true} onClick={() => props.onEdit(null)}>
            Reset room
          </Button>
        </div>
      )}
    </section>
  );
}

export default RoomPanel;

function HeightRow(props: { facts: RoomFacts; edit: RoomEdit | undefined; flat: boolean; onChange(ground: number): void; reports: readonly string[] }) {
  // The entrance is room 1 (keyRooms.ts numberRooms), and the generator never raises it.
  const entrance = props.facts.n === 1;
  const off = entrance || props.flat;
  const value = off ? 0 : (props.edit?.ground ?? props.facts.ground);
  return (
    <Choice<string>
      name="Height"
      value={String(value)}
      onChange={(v) => props.onChange(Number(v))}
      options={ROOM_HEIGHTS.map((h) => ({ value: String(h.value), label: h.label, disabled: off }))}
      help={props.flat ? WING_FLAT : entrance ? ENTRANCE_FLAT : HEIGHT_HELP}
    >
      <Reports lines={props.reports} />
    </Choice>
  );
}

function DoorRows(props: { facts: RoomFacts; edit: RoomEdit | undefined; cave: boolean; onChange(key: string, pin: DoorPin): void; reports: readonly string[] }) {
  if (props.cave) return <Labelled name="Doors">{SECRET_OFF.cave}</Labelled>;
  return (
    <div style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
      {props.facts.doors.map((d) => (
        <DoorRow key={d.key} door={d} pin={props.edit?.doors?.[d.key]} onChange={(pin) => props.onChange(d.key, pin)} />
      ))}
      <Reports lines={props.reports} />
    </div>
  );
}

function DoorRow(props: { door: DoorFacts; pin: DoorPin | undefined; onChange(pin: DoorPin): void }) {
  const { door } = props;
  const state = props.pin ?? (door.state === "open" ? "closed" : door.state);
  return (
    <Choice<DoorPin>
      name={doorName(door.side, door.to)}
      value={state}
      onChange={props.onChange}
      options={[
        { value: "closed", label: "Closed" },
        { value: "locked", label: "Locked" },
        { value: "secret", label: "Secret", disabled: door.secretOk !== null },
      ]}
      help={door.secretOk ?? undefined}
    />
  );
}

function TrapRow(props: { facts: RoomFacts; edit: RoomEdit | undefined; onChange(trap: string | null): void; reports: readonly string[] }) {
  const { facts, edit } = props;
  const held = edit?.trap !== undefined ? edit.trap : facts.trap;
  // A trap the room holds is offered even where the spot list lacks it, so the row always shows what is there.
  const presets = held !== null && !facts.traps.includes(held) ? [...facts.traps, held] : facts.traps;
  if (presets.length === 0) {
    return (
      <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
        <Labelled name="Trap">{NO_TRAP_FITS}</Labelled>
        <Reports lines={props.reports} />
      </div>
    );
  }
  return (
    <Choice<string>
      name="Trap"
      value={held ?? NO_TRAP}
      onChange={(v) => props.onChange(v === NO_TRAP ? null : v)}
      options={[{ value: NO_TRAP, label: "None" }, ...presets.map((id) => ({ value: id, label: trapPreset(id, "1-4")?.name ?? id }))]}
    >
      <Reports lines={props.reports} />
    </Choice>
  );
}

function Labelled(props: { name: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <span style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>{props.name}</span>
      <Help>{props.children}</Help>
    </div>
  );
}

/** A row's reports, in the warning tone, each on its line. */
function Reports(props: { lines: readonly string[] }) {
  if (props.lines.length === 0) return null;
  return (
    <div data-room-reports="" style={{ display: "grid", gap: theme.space(1) }}>
      {props.lines.map((line) => (
        <Help key={line} style={{ color: theme.color.warning }}>
          {line}
        </Help>
      ))}
    </div>
  );
}

