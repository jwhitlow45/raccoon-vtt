import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { Chip, ChipRow } from "../components/Chip.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Empty } from "../components/Empty.tsx";
import { Field, FieldRow, Input, Select, TextArea } from "../components/Field.tsx";
import { Icon, ICON_NAMES } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { Loading, Spinner } from "../components/Loading.tsx";
import { Notice } from "../components/Notice.tsx";
import { Help, Note, Section, SectionLabel } from "../components/Panel.tsx";
import { Row, RowDisk, RowDot, RowList } from "../components/Row.tsx";
import { Segmented } from "../components/Segmented.tsx";
import { SettingRow } from "../components/SettingRow.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { PaneHeader, SheetHeader } from "../components/SheetHeader.tsx";
import { Swatches } from "../components/Swatches.tsx";
import { Switch } from "../components/Switch.tsx";
import { Tag } from "../components/Tag.tsx";
import { Modal } from "../features/images/Modal.tsx";
import { PanelHeaderHost, usePanelHeader, type PanelHeader } from "../features/panels.ts";
import { SheetDialog } from "../features/tokens/SheetDialog.tsx";
import { accentFor, accentVars } from "../lib/accent.ts";
import { MEMBER_COLORS, theme } from "../lib/theme.ts";

/**
 * Every shared component in every state, at `/dev/kit` in development only
 * (docs/design-v1-visual.md 5.1, part 1). The design pass is reviewed
 * here before any screen moves onto the kit, and e2e/kit.e2e.ts drives it
 * with real keys.
 *
 * The accent switch at the top recolors the page as a member's color would
 * in a room: the crest yellow, a blue, and the white that tests contrast
 * hardest. It sets the accent's variables on the document, as the room
 * does (pages/RoomChrome.tsx useAccentVars), so dialogs portaled to the
 * body follow it too.
 *
 * `?accent=blue` or `?accent=white` opens the page in that accent.
 */

const ACCENTS = { yellow: "#f7df00", blue: "#3e8ef7", white: "#e5e5e5" } as const;
type AccentName = keyof typeof ACCENTS;

function initialAccent(): AccentName {
  const asked = new URLSearchParams(location.search).get("accent");
  return asked === "blue" || asked === "white" ? asked : "yellow";
}

export default function Kit() {
  const [accent, setAccent] = useState<AccentName>(initialAccent);
  const vars = useMemo(() => accentVars(accentFor(ACCENTS[accent])), [accent]);
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
    return () => {
      for (const name of Object.keys(vars)) style.removeProperty(name);
    };
  }, [vars]);

  return (
    <main
      style={{
        ...(vars as CSSProperties),
        minHeight: "100dvh",
        background: theme.color.bg,
        color: theme.color.text,
        fontFamily: theme.font.body,
        padding: `calc(${theme.safe.top} + ${theme.space(4)}px) calc(${theme.safe.right} + ${theme.space(4)}px) calc(${theme.safe.bottom} + ${theme.space(8)}px) calc(${theme.safe.left} + ${theme.space(4)}px)`,
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "grid", gap: theme.space(4) }}>
        <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(3) }}>
          <h1 style={{ flex: "1 1 200px", margin: 0, fontSize: theme.font.display, fontWeight: theme.weight.bold }}>Kit</h1>
          <Segmented<AccentName>
            label="Accent"
            value={accent}
            options={[
              { value: "yellow", label: "Yellow" },
              { value: "blue", label: "Blue" },
              { value: "white", label: "White" },
            ]}
            onChange={setAccent}
          />
        </header>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 360px), 1fr))", gap: theme.space(4), alignItems: "start" }}>
          <Buttons />
          <IconsAndHeaders />
          <Settings />
          <Choices />
          <Fields />
          <Rows />
          <ChipsAndTags />
          <Notices />
          <Shells />
          <Folding />
        </div>
      </div>
    </main>
  );
}

/** One card of the kit, on the panel surface the components usually sit on. */
function Card(props: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={props.title}
      style={{
        display: "grid",
        gap: theme.space(3),
        minWidth: 0,
        padding: theme.space(4),
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
      }}
    >
      <h2 style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>{props.title}</h2>
      {props.children}
    </section>
  );
}

function Wrap(props: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2), alignItems: "center" }}>{props.children}</div>;
}

function Buttons() {
  const [pressed, setPressed] = useState(true);
  const [armed, setArmed] = useState(false);
  return (
    <Card title="Buttons">
      <SectionLabel>Medium</SectionLabel>
      <Wrap>
        <Button variant="primary">Create room</Button>
        <Button>Open</Button>
        <Button variant="quiet">Cancel</Button>
        <Button variant="danger" armed={armed} onClick={() => setArmed((a) => !a)}>
          {armed ? "Delete it" : "Delete"}
        </Button>
      </Wrap>
      <SectionLabel>Small</SectionLabel>
      <Wrap>
        <Button size="sm" variant="primary">
          Apply
        </Button>
        <Button size="sm">Show older</Button>
        <Button size="sm" variant="quiet" icon="copy">
          Copy player link
        </Button>
        <Button size="sm" pressed={pressed} onClick={() => setPressed((p) => !p)}>
          DM only
        </Button>
        <Button size="sm" variant="danger" armed>
          Remove
        </Button>
      </Wrap>
      <SectionLabel>Disabled</SectionLabel>
      <Wrap>
        <Button variant="primary" disabled>
          Join
        </Button>
        <Button disabled>Open</Button>
        <Button variant="quiet" disabled>
          Cancel
        </Button>
        <Button variant="danger" disabled>
          Delete
        </Button>
        <Button size="sm" pressed disabled>
          Snap
        </Button>
      </Wrap>
      <SectionLabel>Busy</SectionLabel>
      <Wrap>
        <Button variant="primary" busy>
          Saving…
        </Button>
        <Button size="sm" busy>
          Sending…
        </Button>
      </Wrap>
      <Button variant="primary" block icon="plus">
        New character
      </Button>
    </Card>
  );
}

function IconsAndHeaders() {
  const [armed, setArmed] = useState<string | null>(null);
  return (
    <Card title="Icons and headers">
      <Wrap>
        {ICON_NAMES.map((name) => (
          <IconButton key={name} icon={name} label={`Icon ${name}`} />
        ))}
      </Wrap>
      <Wrap>
        <IconButton icon="filter" label="Filters on" pressed />
        <IconButton icon="more" label="More, disabled" disabled />
        <span style={{ color: theme.color.textMuted, display: "flex", gap: theme.space(2) }}>
          {ICON_NAMES.map((name) => (
            <Icon key={name} name={name} size="sm" />
          ))}
        </span>
      </Wrap>
      <div style={{ minWidth: 0, border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.md }}>
        <SheetHeader title="Initiative" onClose={() => {}} />
      </div>
      <div style={{ minWidth: 0, border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.md }}>
        <SheetHeader
          title="Goblin ambush"
          back={{ label: "Back to Encounters", armed, onBack: () => setArmed((a) => (a ? null : "Discard changes?")) }}
          onClose={() => {}}
          closeLabel="Close Encounters"
        />
      </div>
      <div style={{ minWidth: 0, border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.md }}>
        <SheetHeader
          title="A long sheet title that has to give way"
          back={{ label: "Back to Menu", onBack: () => {} }}
          actions={
            <Button size="sm" icon="chevronRight">
              Thorn
            </Button>
          }
          onClose={() => {}}
        />
      </div>
      <div style={{ minWidth: 0, padding: `0 ${theme.space(2)}px 0 ${theme.space(3)}px`, background: theme.color.overlay, border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.lg, boxShadow: theme.shadow.pane }}>
        <PaneHeader title="Thorn" onClose={() => {}} />
      </div>
    </Card>
  );
}

function Settings() {
  const [fog, setFog] = useState(true);
  const [grid, setGrid] = useState(false);
  const [size, setSize] = useState("100");
  const [speed, setSpeed] = useState("30");
  return (
    <Card title="Settings">
      <Section label="Scene" divider={false}>
        <Switch label="Fog" help="Players see only what you reveal." checked={fog} onChange={setFog} />
        <Switch label="Grid lines" checked={grid} onChange={setGrid} />
        <Switch label="Party vision" help="Turned off for this scene." checked={false} disabled onChange={() => {}} />
        <Switch label="Walls and ledges block players' moves" checked disabled onChange={() => {}} />
        <Switch label="Turn sound" help="Waiting for the server." checked busy onChange={() => {}} />
      </Section>
      <Section label="This device" action={<Button size="sm">Reset</Button>}>
        <SettingRow name="Interface size" help="Bigger text and buttons on this device only." wide>
          {(ids) => (
            <Segmented
              labelledBy={ids.nameId}
              value={size}
              options={["85", "100", "115", "130"].map((v) => ({ value: v, label: `${v}%` }))}
              onChange={setSize}
            />
          )}
        </SettingRow>
        <SettingRow name="Walking speed" help="In feet a turn.">
          {(ids) => <Input type="number" aria-labelledby={ids.nameId} aria-describedby={ids.helpId} value={speed} onChange={(e) => setSpeed(e.target.value)} />}
        </SettingRow>
        <Help>Help explains a setting in one sentence.</Help>
        <Note>A note warns what a change will cost.</Note>
      </Section>
      <Section label="Delete this room" tone="danger">
        <Help>Everything in the room goes for good.</Help>
      </Section>
    </Card>
  );
}

function Choices() {
  const [ability, setAbility] = useState("dex");
  const [kind, setKind] = useState("map");
  const [color, setColor] = useState<string>(MEMBER_COLORS[1]);
  const [secret, setSecret] = useState(false);
  const [players, setPlayers] = useState(true);
  return (
    <Card title="Choices">
      <SectionLabel>Segmented</SectionLabel>
      <Segmented
        label="Ability"
        value={ability}
        options={["str", "dex", "con", "int", "wis", "cha"].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))}
        onChange={setAbility}
      />
      <Segmented
        label="Scene kind"
        grow
        value={kind}
        options={[
          { value: "map", label: "Map" },
          { value: "builder", label: "Builder" },
          { value: "uvtt", label: "Import", disabled: true },
        ]}
        onChange={setKind}
      />
      <Segmented label="Who can read it" disabled value="dm" options={[{ value: "dm", label: "DM only" }, { value: "all", label: "Everyone" }]} onChange={() => {}} />
      <SectionLabel>Swatches</SectionLabel>
      <Swatches
        label="Your color"
        value={color}
        options={[
          { color: "#5a4636", name: "Current color" },
          ...MEMBER_COLORS.map((c, i) => (i === 0 ? { color: c, name: "Yellow, used by a DM", badge: "DM" } : i === 2 ? { color: c, name: "Blue, used by Pat", badge: "P" } : c)),
        ]}
        onChange={setColor}
      />
      <Swatches label="Pin color, disabled" disabled value={MEMBER_COLORS[3]} options={MEMBER_COLORS.slice(0, 5)} onChange={() => {}} />
      <SectionLabel>Checkboxes</SectionLabel>
      <Checkbox label="Secret block" help="Only the DM sees it." checked={secret} onChange={setSecret} />
      <Checkbox label="Players see the DC" checked={players} onChange={setPlayers} />
      <Checkbox label="Hidden on some selected tokens" checked={false} indeterminate onChange={() => {}} />
      <Checkbox label="Played by Pat" checked disabled onChange={() => {}} />
    </Card>
  );
}

function Fields() {
  const [name, setName] = useState("");
  return (
    <Card title="Fields">
      <Field label="Room name" placeholder="Friday game" value={name} onChange={(e) => setName(e.target.value)} />
      <Field label="Your name" hint="Shown to everyone in the room." defaultValue="Dana" />
      <Field label="Player password" error="That password is not right." defaultValue="hunter2" />
      <Field label="Room ID" disabled defaultValue="K7QH-2MXA" />
      <FieldRow label="HP" htmlFor="kit-hp">
        <Input id="kit-hp" type="number" defaultValue={12} />
      </FieldRow>
      <FieldRow label="Name on the map" htmlFor="kit-label" hint="Up to 40 letters.">
        <Input id="kit-label" defaultValue="Goblin Boss" style={{ flex: 1 }} />
      </FieldRow>
      <FieldRow label="Size" htmlFor="kit-size">
        <Select id="kit-size" defaultValue="medium">
          <option value="small">Small</option>
          <option value="medium">Medium</option>
          <option value="large">Large</option>
        </Select>
      </FieldRow>
      <TextArea aria-label="Notes" defaultValue="Text areas share the field look." />
    </Card>
  );
}

function Rows() {
  const [scene, setScene] = useState("cave");
  return (
    <Card title="Rows">
      <RowList label="Members">
        <Row leading={<RowDot color={MEMBER_COLORS[1]} />} title="Pat (you)" detail="Player" trailing={<Tag tone="muted">This device</Tag>} />
        <Row leading={<RowDot color={MEMBER_COLORS[0]} />} title="Dana" detail="DM" trailing={<Tag tone="success">Online</Tag>} />
        <Row
          leading={<RowDot color={MEMBER_COLORS[5]} />}
          title="Lee, whose name is long enough to need cutting short"
          detail="Player, last seen yesterday"
          trailing={<IconButton icon="more" label="More for Lee" />}
        />
      </RowList>
      <div style={{ display: "grid", gap: theme.space(2) }}>
        {[
          { id: "cave", name: "The cave", detail: "Map, 30 x 20" },
          { id: "keep", name: "The keep", detail: "Builder, 40 x 40" },
        ].map((s) => (
          <Row key={s.id} title={s.name} detail={s.detail} chosen={scene === s.id} onClick={() => setScene(s.id)} trailing={<Icon name="chevronRight" />} />
        ))}
        <Row leading={<RowDisk color={theme.color.hostile}>GB</RowDisk>} title="Goblin Boss" detail="AC 17, HP 21" turn trailing={<Tag tone="turn" dense>LA 3/3</Tag>} card />
        <Row title="Join as a new DM" detail="Every DM seat is taken" disabled onClick={() => {}} />
      </div>
      <MovingRows />
    </Card>
  );
}

/** Rows that move and grow, each with a field of its own, to show a row keeps its focus and what was typed in it. */
function MovingRows() {
  const [ids, setIds] = useState(["a", "b", "c"]);
  const added = useRef(0);
  return (
    <Section label="Rows that move">
      <RowList label="Initiative order">
        {ids.map((id) => (
          <Row key={id} title={`Creature ${id.toUpperCase()}`} trailing={<Input aria-label={`Note for ${id.toUpperCase()}`} style={{ width: 120 }} />} />
        ))}
      </RowList>
      <Wrap>
        <Button size="sm" onClick={() => setIds((list) => [list[list.length - 1]!, ...list.slice(0, -1)])}>
          Move the last row to the top
        </Button>
        <Button size="sm" onClick={() => setIds((list) => [`n${++added.current}`, ...list])}>
          Add a row at the top
        </Button>
      </Wrap>
    </Section>
  );
}

function ChipsAndTags() {
  const [on, setOn] = useState<Set<string>>(new Set(["Monsters"]));
  const toggle = (label: string) =>
    setOn((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  return (
    <Card title="Chips and tags">
      <ChipRow label="Filters">
        {[
          ["Monsters", 4],
          ["Characters", 2],
          ["Objects", 0],
        ].map(([label, count]) => (
          <Chip key={label} count={count as number} pressed={on.has(label as string)} onClick={() => toggle(label as string)}>
            {label}
          </Chip>
        ))}
        <Chip pressed disabled onClick={() => {}}>
          Under fog
        </Chip>
        <Chip disabled onClick={() => {}}>
          Hidden
        </Chip>
      </ChipRow>
      <ChipRow label="Filters that are on">
        {[...on].map((label) => (
          <Chip key={label} remove aria-label={`Remove the filter ${label}`} onClick={() => toggle(label)}>
            {label}
          </Chip>
        ))}
      </ChipRow>
      <Wrap>
        <Tag tone="success">Healthy</Tag>
        <Tag tone="warning">Bloodied</Tag>
        <Tag tone="danger">Dying</Tag>
        <Tag tone="muted">Under fog</Tag>
        <Tag tone="turn">Players here</Tag>
        <Tag tone="turn" dense>
          LA 2/3
        </Tag>
      </Wrap>
    </Card>
  );
}

function Notices() {
  return (
    <Card title="Notices and empty states">
      <Notice tone="info" role="status">
        Loading the scene…
      </Notice>
      <Notice tone="warning" role="status" float>
        Reconnecting… Your changes are kept and will be sent when the connection is back.
      </Notice>
      <Notice tone="danger" role="status">
        You are offline. Your changes are kept and will be sent when you reconnect.
      </Notice>
      <Notice
        tone="highlight"
        action={
          <Button size="sm" style={{ minWidth: theme.touch }}>
            Exit preview
          </Button>
        }
      >
        You are viewing as Pat.
      </Notice>
      <Empty>No fight is running.</Empty>
      <Empty action={<Button size="sm" icon="plus">New page</Button>}>The journal is empty. Add a page for notes, handouts or lore.</Empty>
      <Loading text="Loading the monsters…" delay={0} />
      <span style={{ color: theme.color.textMuted, display: "flex", gap: theme.space(2), alignItems: "center", fontSize: theme.font.body14 }}>
        <Spinner /> A spinner alone
      </span>
    </Card>
  );
}

function Shells() {
  const [open, setOpen] = useState<null | "fill" | "sheet" | "modal" | "sheetDialog" | "tabs">(null);
  const [ability, setAbility] = useState("dex");
  const close = () => setOpen(null);
  const footer = (
    <>
      <Button onClick={close}>Cancel</Button>
      <Button variant="primary" onClick={close}>
        Save
      </Button>
    </>
  );
  return (
    <Card title="Dialogs">
      <Wrap>
        <Button size="sm" onClick={() => setOpen("fill")}>
          Editor dialog
        </Button>
        <Button size="sm" onClick={() => setOpen("sheet")}>
          Picker dialog
        </Button>
        <Button size="sm" onClick={() => setOpen("modal")}>
          Modal wrapper
        </Button>
        <Button size="sm" onClick={() => setOpen("sheetDialog")}>
          SheetDialog wrapper
        </Button>
        <Button size="sm" onClick={() => setOpen("tabs")}>
          Tab order dialog
        </Button>
      </Wrap>
      {open === "tabs" ? (
        // A body that ends in a choice and no footer: the choice is the dialog's last Tab stop, where the focus trap must wrap.
        <Dialog title="Pick an ability" width="sm" phone="sheet" onClose={close}>
          <div style={{ display: "grid", gap: theme.space(3) }}>
            <Help>Tab from the chosen ability goes back to Close.</Help>
            <Segmented
              label="Ability for the check"
              value={ability}
              options={[
                { value: "str", label: "Str" },
                { value: "dex", label: "Dex" },
                { value: "con", label: "Con" },
              ]}
              onChange={setAbility}
            />
          </div>
        </Dialog>
      ) : null}
      {open === "fill" ? (
        <Dialog title="New page" width="md" onClose={close} footer={footer} status="Saved as a draft on this device.">
          <div style={{ display: "grid", gap: theme.space(4) }}>
            <Field label="Title" defaultValue="The old mill" />
            <SettingRow name="Who can read it" wide>
              {(ids) => <Segmented labelledBy={ids.nameId} value="dm" options={[{ value: "dm", label: "DM only" }, { value: "all", label: "Everyone" }]} onChange={() => {}} />}
            </SettingRow>
            <TextArea aria-label="Text" rows={8} defaultValue="Write the page here." />
          </div>
        </Dialog>
      ) : null}
      {open === "sheet" ? (
        <Dialog title="Request a roll" width="md" phone="sheet" backClose onClose={close} footer={footer}>
          <Segmented label="What to roll" value="save" options={[{ value: "save", label: "Saving throw" }, { value: "check", label: "Ability check" }]} onChange={() => {}} />
        </Dialog>
      ) : null}
      {open === "modal" ? (
        <Modal title="Export the log" onClose={close}>
          <Help>Modal keeps working for its callers while they move to Dialog.</Help>
        </Modal>
      ) : null}
      {open === "sheetDialog" ? (
        <SheetDialog title="3 tokens" onClose={close} footer={<Button onClick={close}>Done</Button>}>
          <Checkbox label="Hidden from players" checked={false} indeterminate onChange={() => {}} />
        </SheetDialog>
      ) : null}
    </Card>
  );
}

/**
 * A phone sheet in a box of its own: a panel whose subpages name
 * themselves through usePanelHeader, also when a control outside the sheet
 * opens or closes one, the reserve a dock would take, and a folded part
 * that keeps its inline display under the `hidden` attribute.
 */
function Folding() {
  const [header, setHeader] = useState<PanelHeader | null>(null);
  const [reserve, setReserve] = useState(false);
  const [folded, setFolded] = useState(true);
  const [remote, setRemote] = useState<Remote>({ n: 0, page: null });
  return (
    <Card title="Sheets and folding">
      <Switch label="Reserve room for the dock" help="Keeps 56 px above the sheet, as the dock does on a phone." checked={reserve} onChange={setReserve} />
      <div style={{ position: "relative", height: 420, overflow: "hidden", borderRadius: theme.radius.md, background: theme.color.fog, border: `${theme.line.border}px solid ${theme.color.border}` }}>
        <Sheet title="Menu" mode="bottom" headerWidth={360} inset={{ top: 0, bottom: 0 }} reserveTop={reserve ? 56 : 0} subpage={header} onClose={() => {}}>
          <PanelHeaderHost onHeader={setHeader}>
            <KitMenu remote={remote} />
          </PanelHeaderHost>
        </Sheet>
      </div>
      <Wrap>
        <Button size="sm" onClick={() => setRemote((r) => ({ n: r.n + 1, page: "settings" }))}>
          Open Room settings from outside the sheet
        </Button>
        <Button size="sm" onClick={() => setRemote((r) => ({ n: r.n + 1, page: null }))}>
          Close the subpage from outside the sheet
        </Button>
      </Wrap>
      <Switch label="Fold the token bar" checked={folded} onChange={setFolded} />
      <Button size="sm">Before the folded bar</Button>
      <div hidden={folded} data-kit="folded" role="group" aria-label="Folded token bar" style={{ display: "grid", gap: theme.space(2), padding: theme.space(2), border: `${theme.line.border}px dashed ${theme.color.border}`, borderRadius: theme.radius.md }}>
        <Button size="sm">Inside the folded bar</Button>
        <Input aria-label="Folded HP" defaultValue="7" />
      </div>
      <Button size="sm">After the folded bar</Button>
    </Card>
  );
}

type KitPage = null | "members" | "encounter" | "settings" | { notes: 1 | 2 } | { handout: Handout };
type Handout = { id: string; name: string };
/** A subpage opened or closed by a control outside the sheet, as a shortcut or another panel can. `n` counts the presses. */
type Remote = { n: number; page: KitPage };

const ENCOUNTER_NAMES = ["Goblin ambush", "Bandit camp", "Owlbear den"];

/**
 * A panel with subpages of every kind useSubpageFocus meets: plain ones,
 * one that renames itself as its name is typed and can switch to another
 * (it passes an `id`), two rows with one name, and rows marked with an
 * `opener` id that move or go away while their subpage is open.
 */
function KitMenu(props: { remote: Remote }) {
  const [page, setPage] = useState<KitPage>(null);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const [encounter, setEncounter] = useState({ n: 0, name: ENCOUNTER_NAMES[0]! });
  const [handouts, setHandouts] = useState<Handout[]>([
    { id: "map", name: "Map of the keep" },
    { id: "letter", name: "Letter" },
  ]);
  const leave = useRef(() => {
    setPage(null);
    setDirty(false);
    setAsking(false);
  });
  const { remote } = props;
  useEffect(() => {
    if (remote.n === 0) return;
    if (remote.page === null) leave.current();
    else setPage(remote.page);
  }, [remote]);
  usePanelHeader(
    page === "members" || page === "settings"
      ? { title: page === "members" ? "Members" : "Room settings", parent: "Menu", onBack: leave.current }
      : page === "encounter"
        ? {
            id: `encounter-${encounter.n}`,
            title: encounter.name || "Untitled encounter",
            parent: "Encounters",
            armed: asking ? "Discard changes?" : null,
            // With unsaved changes the first tap asks, and the second leaves (3.3).
            onBack: () => (dirty && !asking ? setAsking(true) : leave.current()),
          }
        : page && "notes" in page
          ? { title: `Notes ${page.notes}`, parent: "Menu", onBack: leave.current }
          : page && "handout" in page
            ? { title: page.handout.name, parent: "Menu", onBack: leave.current }
            : null,
  );
  if (page === "members") {
    return (
      <RowList label="Members">
        <Row leading={<RowDot color={MEMBER_COLORS[1]} />} title="Pat (you)" detail="Player" />
        <Row leading={<RowDot color={MEMBER_COLORS[0]} />} title="Dana" detail="DM" />
      </RowList>
    );
  }
  if (page === "settings") {
    // Longer than the sheet may grow, so the sheet shows its cap.
    return (
      <div>
        {Array.from({ length: 12 }, (_, i) => (
          <Switch key={i} label={`Setting ${i + 1}`} checked={i % 3 === 0} onChange={() => {}} />
        ))}
      </div>
    );
  }
  if (page === "encounter") {
    return (
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <Help>Change something, then go back: the back button asks first. The name titles the page as it is typed.</Help>
        <Field label="Encounter name" value={encounter.name} onChange={(e) => setEncounter({ ...encounter, name: e.target.value })} />
        <Wrap>
          <Button
            size="sm"
            onClick={() => {
              setDirty(true);
              setAsking(false);
            }}
          >
            Add a goblin
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const n = (encounter.n + 1) % ENCOUNTER_NAMES.length;
              setEncounter({ n, name: ENCOUNTER_NAMES[n]! });
              setDirty(false);
              setAsking(false);
            }}
          >
            Next encounter
          </Button>
        </Wrap>
      </div>
    );
  }
  if (page && "notes" in page) return <Help>One of two pages behind rows of the same name.</Help>;
  if (page && "handout" in page) {
    const { handout } = page;
    return (
      <Wrap>
        <Button size="sm" onClick={() => setHandouts((list) => [handout, ...list.filter((h) => h.id !== handout.id)])}>
          Move this to the top
        </Button>
        <Button size="sm" variant="danger" onClick={() => setHandouts((list) => list.filter((h) => h.id !== handout.id))}>
          Remove this one
        </Button>
      </Wrap>
    );
  }
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <Row title="Members" onClick={() => setPage("members")} trailing={<Icon name="chevronRight" />} />
      <Row title="Encounter editor" onClick={() => setPage("encounter")} trailing={<Icon name="chevronRight" />} />
      <Row title="Room settings" onClick={() => setPage("settings")} trailing={<Icon name="chevronRight" />} />
      <Row title="Notes" onClick={() => setPage({ notes: 1 })} trailing={<Icon name="chevronRight" />} />
      <Row title="Notes" onClick={() => setPage({ notes: 2 })} trailing={<Icon name="chevronRight" />} />
      {handouts.map((h) => (
        <Row key={h.id} opener={`handout-${h.id}`} title={h.name} onClick={() => setPage({ handout: h })} trailing={<Icon name="chevronRight" />} />
      ))}
    </div>
  );
}
