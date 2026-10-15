import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { generatePassphrase } from "#shared/passphrase.ts";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { Card, ErrorText, Field, Page } from "../components/Field.tsx";
import { Icon } from "../components/Icon.tsx";
import { Notice } from "../components/Notice.tsx";
import { Help } from "../components/Panel.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { useTurnstile } from "../components/Turnstile.tsx";
import { weakPasswordText } from "../features/dm/invite.ts";
import { PlayerLinkShare } from "../features/dm/PlayerLinkShare.tsx";
import { ImportRoomCard } from "../features/settings/ImportRoomCard.tsx";
import { api, ApiError } from "../lib/api.ts";
import { rememberedName, rememberName } from "../lib/device.ts";
import { checkStanding, forgetRoom, readKnownRooms, refreshRoom, rememberRoom, takeHomeNotice, type KnownRoom, type RoomStanding } from "../lib/knownRooms.ts";
import { navigate } from "../lib/navigation.ts";
import { offerLinkPassword, readJoinInput } from "../lib/playerLink.ts";
import { formatRoomId, roomPath } from "../lib/roomId.ts";
import { theme } from "../lib/theme.ts";
import { DmLinkEntry } from "./DmLinkEntry.tsx";
import { TableDisplayCard } from "../features/display/HomeCard.tsx";

const MIN_PASSWORD = 8;

/**
 * Home (design section 14.1): the rooms this device has been in, then join a
 * room, create one, or enter a DM link. The installed app opens here, and
 * "Leave room" comes back here, so the list saves retyping a room ID.
 */
export function Home() {
  const [created, setCreated] = useState<{ roomId: string; dmLink: string; password: string } | null>(null);
  // Taken once per visit, so it is not shown again after a reload or a return.
  const [notice] = useState(takeHomeNotice);
  if (created) return <DmLinkReveal {...created} />;
  return (
    <Page>
      <HomeHeader tagline="A virtual tabletop for your group." />
      {notice ? <Notice role="status">{notice}</Notice> : null}
      <YourRooms />
      <JoinCard />
      <CreateCard onCreated={setCreated} />
      <ImportRoomCard onImported={setCreated} />
      <DmLinkEntry />
      <TableDisplayCard
        foot={
          <Help>
            Tip: join your room here first, then add the app to your Home Screen. On iPhone, the Home Screen app keeps its
            own sign-in, so a DM signs in there with "Enter a DM link or invite".
          </Help>
        }
      />
    </Page>
  );
}

/**
 * The logo and a name over a page outside a room: Home, the error pages
 * and Admin. An error page that carries it still reads as this app, where
 * a bare card looked like a server's error page.
 */
export function HomeHeader(props: { title?: string; tagline?: string; actions?: ReactNode }) {
  return (
    <header style={{ display: "flex", alignItems: "center", gap: theme.space(3), flexWrap: "wrap" }}>
      <img src="/icon.svg" alt="" width={48} height={48} />
      {/* Its own width first, so on a phone the actions wrap under the name instead of squeezing it onto two lines. */}
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: theme.font.display, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>{props.title ?? "RaccoonVTT"}</h1>
        {props.tagline ? <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>{props.tagline}</p> : null}
      </div>
      {props.actions ? <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>{props.actions}</div> : null}
    </header>
  );
}

/**
 * The rooms this device remembers (client/lib/knownRooms.ts), each checked
 * with the server when the page opens: whether this device is still signed
 * in there, and as whom. A deleted room leaves the list.
 */
function YourRooms() {
  const [rooms, setRooms] = useState<KnownRoom[]>(() => readKnownRooms());
  const [standing, setStanding] = useState<Record<string, RoomStanding>>({});

  useEffect(() => {
    let live = true;
    for (const room of rooms) {
      void checkStanding(room.roomId, api).then((s) => {
        if (!live) return;
        if (s.kind === "gone") {
          forgetRoom(room.roomId);
          setRooms((list) => list.filter((r) => r.roomId !== room.roomId));
          return;
        }
        if (s.kind === "in") refreshRoom(room.roomId, { role: s.role, memberName: s.memberName, ...(s.roomName ? { name: s.roomName } : {}) });
        else if (s.kind === "out" && s.roomName) refreshRoom(room.roomId, { name: s.roomName });
        setStanding((all) => ({ ...all, [room.roomId]: s }));
      });
    }
    return () => {
      live = false;
    };
    // Checked once when Home opens. Forgetting a room needs no new check.
  }, []);

  if (rooms.length === 0) return null;
  return (
    <Card title="Your rooms">
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(2) }}>
        {rooms.map((room) => (
          <KnownRoomRow
            key={room.roomId}
            room={room}
            standing={standing[room.roomId] ?? null}
            onForget={() => {
              forgetRoom(room.roomId);
              setRooms((list) => list.filter((r) => r.roomId !== room.roomId));
            }}
          />
        ))}
      </ul>
    </Card>
  );
}

function KnownRoomRow(props: { room: KnownRoom; standing: RoomStanding | null; onForget(): void }) {
  const { room, standing } = props;
  const s = standing?.kind === "in" ? standing : null;
  const role = s?.role ?? room.role;
  const memberName = s?.memberName ?? room.memberName;
  const name = (s?.roomName || (standing?.kind === "out" ? standing.roomName : null) || room.name).trim() || `Room ${formatRoomId(room.roomId)}`;
  const who = role === "dm" ? (memberName ? `DM, as ${memberName}` : "DM") : memberName ? `as ${memberName}` : "player";
  const status =
    standing === null
      ? "Checking…"
      : standing.kind === "out"
        ? role === "dm"
          ? "Signed out on this device. Use your DM link to come back as DM."
          : "Signed out on this device. Join again with the password or player link."
        : standing.kind === "unknown"
          ? "Could not check just now."
          : null;
  return (
    <li style={{ display: "flex", alignItems: "stretch", gap: theme.space(2) }}>
      <button
        type="button"
        onClick={() => navigate(roomPath(room.roomId))}
        style={{
          flex: 1,
          minWidth: 0,
          display: "grid",
          gap: theme.space(0.5),
          minHeight: theme.touch + theme.space(3),
          padding: `${theme.space(2)}px ${theme.space(3)}px`,
          borderRadius: theme.radius.md,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          background: theme.color.surfaceRaised,
          color: theme.color.text,
          textAlign: "left",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, overflowWrap: "anywhere" }}>{name}</span>
        <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
          <span style={{ fontFamily: theme.font.mono }}>{formatRoomId(room.roomId)}</span> · {who}
        </span>
        {status ? (
          <span style={{ fontSize: theme.font.small, color: standing?.kind === "out" ? theme.color.warning : theme.color.textMuted }}>{status}</span>
        ) : null}
      </button>
      <Button variant="danger" size="sm" onClick={props.onForget} aria-label={`Forget ${name} on this device`} style={{ alignSelf: "center" }}>
        Forget
      </Button>
    </li>
  );
}

function JoinCard() {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const target = readJoinInput(input);
    if (!target) {
      setError("Room IDs have 8 letters and digits, like K7QH-2MXA.");
      return;
    }
    // A pasted player link brings its password along without ever putting
    // it in the address bar. This is how a player joins inside an iPhone
    // Home Screen app, which keeps its own sign-in.
    if (target.fragment) offerLinkPassword(target.roomId, target.fragment.password);
    navigate(roomPath(target.roomId));
  }
  return (
    <Card title="Join a room">
      <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
        <Field
          label="Room ID"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          placeholder="K7QH-2MXA"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          error={error}
        />
        <Button type="submit" variant="primary" block disabled={input.trim() === ""}>
          Join
        </Button>
      </form>
    </Card>
  );
}

function createErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  if (err.status === 429) return "Too many rooms were created from here today. Try again tomorrow.";
  if (err.code === "weak_password") return weakPasswordText(err.detail.reason);
  if (err.code === "turnstile_failed") return "The human check did not pass. Try again.";
  if (err.code === "turnstile_unavailable") return "The human check is not answering. Try again in a minute.";
  return err.message;
}

function CreateCard(props: { onCreated(created: { roomId: string; dmLink: string; password: string }): void }) {
  const [name, setName] = useState("");
  const [dmName, setDmName] = useState(rememberedName);
  const [password, setPassword] = useState(() => generatePassphrase());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const turnstile = useTurnstile();
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !dmName.trim()) {
      setError("Give the room a name, and enter yours.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`The player password needs at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (turnstile.required && !turnstile.token) {
      setError("Wait a moment for the human check to finish.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.createRoom({
        name: name.trim(),
        playerPassword: password,
        dmName: dmName.trim(),
        ...(turnstile.token ? { turnstileToken: turnstile.token } : {}),
      });
      rememberName(dmName.trim());
      // Remembered before the DM link shows, not when the room is entered. The
      // link is shown only once, and a reload or a phone dropping the tab before
      // "Continue" would leave this device a DM of a room it cannot find.
      rememberRoom({ roomId: res.roomId, name: name.trim(), me: { role: "dm", member: { name: dmName.trim() } } });
      props.onCreated({ roomId: res.roomId, dmLink: res.dmLink, password });
    } catch (err) {
      setError(createErrorMessage(err));
    } finally {
      setBusy(false);
      turnstile.reset();
    }
  }

  return (
    <Card title="Create a room">
      <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
        <Field label="Room name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Tuesday campaign" />
        <Field
          label="Your name"
          value={dmName}
          onChange={(e) => setDmName(e.target.value)}
          maxLength={80}
          autoComplete="nickname"
          hint="You will be the DM."
        />
        <Field
          label="Player password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          maxLength={128}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          hint="Players type this to join. At least 8 characters. Three words are easy to say out loud."
          error={tooShort ? `At least ${MIN_PASSWORD} characters.` : null}
          trailing={
            <Button onClick={() => setPassword(generatePassphrase())} aria-label="Suggest another password">
              New
            </Button>
          }
        />
        {turnstile.widget}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" block busy={busy} disabled={!busy && turnstile.pending}>
          {busy ? "Creating…" : "Create room"}
        </Button>
      </form>
    </Card>
  );
}

/**
 * The DM link is shown once, right after creation (design section 10.1).
 * Only its hash is stored on the server, so losing it means asking the
 * server owner for a new one. The checkbox makes saving it a deliberate step.
 */
function DmLinkReveal(props: { roomId: string; dmLink: string; password: string }) {
  const link = new URL(props.dmLink, location.origin).href;
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qrShown, setQrShown] = useState(false);
  const canShare = typeof navigator.share === "function";

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Page>
      <h1 style={{ margin: 0, fontSize: theme.font.display, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>Save your DM link</h1>
      <p style={{ margin: 0, color: theme.color.textMuted }}>
        Opening this link on any device makes it a DM device for this room. It is shown only this once. Keep it
        somewhere safe, like a password manager, and do not share it with players.
      </p>
      <Card>
        <code
          style={{
            display: "block",
            padding: theme.space(3),
            borderRadius: theme.radius.md,
            background: theme.color.bg,
            fontFamily: theme.font.mono,
            fontSize: theme.font.body14,
            wordBreak: "break-all",
            userSelect: "all",
          }}
        >
          {link}
        </code>
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button icon="copy" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </Button>
          {canShare ? (
            <Button onClick={() => void navigator.share({ title: "DM link", url: link }).catch(() => {})}>Share</Button>
          ) : null}
        </div>
        {/* Folded away, so a player at the table scans the player link's code below, never this one. */}
        <details onToggle={(e) => setQrShown(e.currentTarget.open)}>
          {/*
           * A disclosure is not a link, so it takes the text color, not the
           * accent. A flex summary draws no marker of its own, and the
           * chevron turns down while it is open.
           */}
          <summary
            style={{
              display: "flex",
              alignItems: "center",
              gap: theme.space(2),
              minHeight: theme.touch,
              listStyle: "none",
              cursor: "pointer",
              color: theme.color.text,
              fontSize: theme.font.body14,
              fontWeight: theme.weight.strong,
            }}
          >
            <Icon name={qrShown ? "chevronDown" : "chevronRight"} size="sm" />
            Show a QR code for another DM device
          </summary>
          <div style={{ display: "grid", justifyItems: "center", gap: theme.space(2) }}>
            <QrCode value={link} label="QR code of the DM link" />
            <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, textAlign: "center" }}>
              Scan this with another device of yours to make it a DM device too. Never show it to players.
            </span>
          </div>
        </details>
      </Card>
      <Card title="For your players">
        <p style={{ margin: 0, color: theme.color.textMuted }}>
          Send your players this link, or let them scan the code. The password is in the link, so share it only with
          your group.
        </p>
        <PlayerLinkShare roomId={props.roomId} password={props.password} />
      </Card>
      <Checkbox label="I saved my DM link" checked={saved} onChange={setSaved} />
      <Button variant="primary" block disabled={!saved} onClick={() => navigate(roomPath(props.roomId))}>
        Continue to the room
      </Button>
    </Page>
  );
}
