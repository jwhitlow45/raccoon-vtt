import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Member } from "#shared/model.ts";
import { DeleteRoom, DmDevices, MemberActions, PlayerPassword } from "../features/dm/Access.tsx";
import { usePreview } from "../features/dm/previewContext.ts";
import type { PanelProps } from "../features/panels.ts";
import { Button } from "../components/Button.tsx";
import { Loading } from "../components/Loading.tsx";
import { Help } from "../components/Panel.tsx";
import { Row, RowDot, RowList } from "../components/Row.tsx";
import { Swatches } from "../components/Swatches.tsx";
import { Tag } from "../components/Tag.tsx";
import { accentFor } from "../lib/accent.ts";
import { buttonNote, memberSwatches } from "../lib/memberColor.ts";
import { theme } from "../lib/theme.ts";
import { useRoomActions, useRoomView } from "../state/view.ts";

/**
 * The roster with who is online (features section 1), your own color
 * (docs/design-v1-visual.md section 4), and for the DM the access tools:
 * kick, remove DM, the player password, DM devices, the DM link and
 * deleting the room (design 10.2).
 */
export default function MembersPanel(_props: PanelProps) {
  const members = useRoomView((s) => s.view?.members);
  const online = useRoomView((s) => s.online);
  const you = useRoomView((s) => s.you);
  const preview = usePreview();
  const dm = you?.role === "dm" && !preview;
  const [picking, setPicking] = useState(false);
  const colorButton = useRef<HTMLButtonElement>(null);
  const pickerId = useId();

  const roster = useMemo(() => {
    const list = Object.values(members ?? {}).filter((m): m is Member => m !== undefined);
    // DMs first, then players, each by name.
    return list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dm" ? -1 : 1));
  }, [members]);
  const others = useMemo(() => roster.filter((m) => m.id !== you?.memberId), [roster, you?.memberId]);
  const onlineSet = useMemo(() => new Set(online), [online]);

  if (!members) return <Loading text="Loading…" />;
  return (
    <div style={{ display: "grid" }}>
      <div style={{ paddingBottom: theme.space(3) }}>
        <RowList label="Members">
          {roster.map((m) => {
            const own = m.id === you?.memberId;
            // The preview refuses every op and disables Leave room (panels/MenuPanel.tsx), so it offers no color either.
            const canPick = own && !preview;
            const open = canPick && picking;
            const isOnline = onlineSet.has(m.id);
            return (
              <div key={m.id} style={{ display: "grid", gap: theme.space(2), paddingBottom: open || (dm && !own) ? theme.space(2) : 0 }}>
                <Row
                  leading={<RowDot color={m.color} />}
                  title={
                    <>
                      {m.name}
                      {own ? <span style={{ color: theme.color.textMuted, fontWeight: theme.weight.regular }}> (you)</span> : null}
                    </>
                  }
                  detail={m.kind === "dm" ? "DM" : "Player"}
                  trailing={
                    <>
                      <Tag tone={isOnline ? "success" : "muted"}>{isOnline ? "Online" : "Offline"}</Tag>
                      {canPick ? (
                        <Button
                          ref={colorButton}
                          size="sm"
                          aria-label="Change your color"
                          aria-expanded={open}
                          aria-controls={open ? pickerId : undefined}
                          onClick={() => setPicking(!picking)}
                        >
                          <RowDot color={m.color} size={14} />
                          Color
                        </Button>
                      ) : null}
                    </>
                  }
                />
                {open ? (
                  <ColorPicker
                    id={pickerId}
                    member={m}
                    others={others}
                    onDone={() => {
                      setPicking(false);
                      colorButton.current?.focus();
                    }}
                  />
                ) : null}
                {dm && !own ? (
                  <div style={{ padding: `0 ${theme.space(3)}px` }}>
                    <MemberActions memberId={m.id} name={m.name} kind={m.kind} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </RowList>
      </div>
      {dm ? (
        <>
          <PlayerPassword />
          <DmDevices />
          <DeleteRoom />
        </>
      ) : null}
    </div>
  );
}

/**
 * Your own color, under your row (docs/design-v1-visual.md 4.2 and 4.3). A
 * tap applies at once, like a switch: the store predicts it, so the swatch,
 * the dot and the whole interface's accent change before the server
 * answers, and a refusal puts the old color back with the usual message.
 *
 * Every tap of one opening shares one undo group, made when the picker
 * opens, so a DM who tries four colors undoes them in one step ("changing
 * your name or color", server/rooms/undoLabels.ts).
 *
 * Only palette colors are sent, six lowercase hex digits, and the op's
 * schema stays as it is: replay checks every stored op against today's
 * schema, so a tighter one could leave a room read-only (design 4.3).
 */
function ColorPicker(props: { id: string; member: Member; others: readonly Member[]; onDone(): void }) {
  const actions = useRoomActions();
  const [group] = useState(() => actions.newId());
  const box = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const color = props.member.color;
  const options = useMemo(() => memberSwatches({ players: props.others, current: color }), [props.others, color]);

  // A phone sheet is at most 60% of the screen, and under a lower row the picker would open out of sight.
  // Braces, since Chrome's scrollIntoView now returns a promise, which React would take for a cleanup.
  useEffect(() => {
    void box.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div
      id={props.id}
      ref={box}
      style={{
        display: "grid",
        gap: theme.space(3),
        margin: `0 ${theme.space(3)}px`,
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.surfaceRaised,
      }}
    >
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <span id={labelId} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
          Your color
        </span>
        <Swatches
          labelledBy={labelId}
          value={color}
          options={options}
          onChange={(next) => {
            if (next.toLowerCase() !== color.toLowerCase()) actions.dispatch({ t: "member.update", memberId: props.member.id, color: next }, { group });
          }}
        />
      </div>
      <ColorPreview color={color} />
      <div style={{ display: "flex", alignItems: "flex-end", gap: theme.space(3) }}>
        <Help style={{ flex: 1, minWidth: 0 }}>Your pings, laser, rulers and buttons change now. Drawings, pins and areas you already made keep their color.</Help>
        <Button size="sm" onClick={props.onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * The button color beside the map color. The accent lightens a color that
 * would not read on the dark surfaces (lib/accent.ts), and the crest orange
 * stays yellow, so without this a member could not tell why their buttons
 * and their pings differ. The sample is a picture of a button, hidden from
 * screen readers, and the note under it says the same in words.
 */
function ColorPreview(props: { color: string }) {
  const shown = accentFor(props.color);
  const note = buttonNote(props.color);
  const label = { fontSize: theme.font.small, color: theme.color.textMuted };
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <div aria-hidden style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: `${theme.space(2)}px ${theme.space(4)}px` }}>
        <span style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <span style={label}>Buttons</span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: theme.space(8),
              padding: `0 ${theme.space(3)}px`,
              borderRadius: theme.radius.md,
              background: shown.accent,
              color: shown.onAccent,
              fontSize: theme.font.body14,
              fontWeight: theme.weight.strong,
            }}
          >
            Send
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <span style={label}>Pings and drawings</span>
          <RowDot color={props.color} size={16} />
        </span>
      </div>
      {note ? <Help>{note}</Help> : null}
    </div>
  );
}
