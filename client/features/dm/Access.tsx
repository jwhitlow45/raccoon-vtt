import { useCallback, useEffect, useRef, useState } from "react";
import { generatePassphrase } from "#shared/passphrase.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorText, Field } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { QrCode } from "../../components/QrCode.tsx";
import { Row, RowList } from "../../components/Row.tsx";
import { Tag } from "../../components/Tag.tsx";
import { api, ApiError, type DmDevice, type DmInviteState } from "../../lib/api.ts";
import { forgetRoom, setHomeNotice } from "../../lib/knownRooms.ts";
import { navigate } from "../../lib/navigation.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { ConfirmAction, SecretLink } from "./controls.tsx";
import { absoluteLink, deviceSeenText, inviteCountdown, inviteUsed, passwordProblem, weakPasswordText } from "./invite.ts";
import { PlayerLinkShare } from "./PlayerLinkShare.tsx";
import { createPlayerLinkLoader, type LinkState } from "./playerLinkLoader.ts";

/**
 * The DM's access tools (design 10.2 and 10.8). Each runs over HTTP, not as
 * an op, because each reaches outside the room state: grants, sessions,
 * invites and the DM key. The server does every check again. These
 * components only make each action deliberate and say what it will do.
 */

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "weak_password") return weakPasswordText(err.detail.reason);
    if (err.code === "dm_only" || err.code === "no_access") return "Only a DM device can do that. This device may have been signed out.";
    if (err.code === "too_many_invites") return "There are already 20 unused invites. Wait for some to expire.";
    if (err.code === "name_mismatch") return "That is not the room's name. Type it exactly as shown.";
    if (err.code === "cannot_kick_self" || err.code === "cannot_remove_self") return "You cannot do that to yourself.";
    return err.message;
  }
  return "Something went wrong. Try again.";
}

/** Kick, remove from the roster, and remove DM for one roster row. */
export function MemberActions(props: { memberId: string; name: string; kind: "dm" | "player" }) {
  const roomId = useRoomView((s) => s.roomId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // "Quinn was signed out" is stale once Quinn is back, and old news after a minute either way.
  const online = useRoomView((s) => s.online.includes(props.memberId));
  useEffect(() => {
    if (online) setDone(null);
  }, [online]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 60_000);
    return () => clearTimeout(timer);
  }, [done]);
  const run = async (action: () => Promise<void>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setDone(message);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
        {props.kind === "dm" ? (
          <ConfirmAction
            label="Remove DM"
            busy={busy}
            danger
            warning={`${props.name} loses DM on every device and becomes a player. Their sockets close now. They can rejoin as a player with the password.`}
            onConfirm={() => run(() => api.removeDm(roomId, props.memberId), `${props.name} is no longer a DM.`)}
          />
        ) : null}
        <ConfirmAction
          label="Kick"
          busy={busy}
          danger
          warning={`Sign ${props.name} out on every device? They stay in this list and can rejoin with the player password. To keep them out, change the password too.`}
          onConfirm={() => run(() => api.kick(roomId, props.memberId), `${props.name} was signed out.`)}
        />
        <ConfirmAction
          label="Remove"
          confirmLabel="Remove"
          busy={busy}
          danger
          warning={`Sign ${props.name} out on every device and take them off this list? Their drawings and areas are deleted, and their tokens and characters lose them as an owner. This cannot be undone. With the player password they can only join again as someone new.`}
          onConfirm={() => run(() => api.removeMember(roomId, props.memberId), `${props.name} was removed.`)}
        />
      </div>
      {done ? <Notice role="status">{done}</Notice> : null}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/**
 * The player link and its QR code, at any time (design 10.2, decided in
 * section 17). It is fetched only when the DM asks, and hides again, so
 * the link that lets anyone in is not on a screen the table can see unless
 * the DM means to show it.
 *
 * `main` makes "Show the player link" the primary button, as on the
 * Members page, where it is what the page is for. In the DM tab it acts
 * on the side of play, so it is secondary there.
 */
export function PlayerLinkSection(props: { main?: boolean }) {
  const roomId = useRoomView((s) => s.roomId);
  const accessVersion = useRoomView((s) => s.accessVersion);
  const [state, setState] = useState<LinkState>({ kind: "hidden" });
  const [loader] = useState(() =>
    createPlayerLinkLoader({ fetch: async () => (await api.getPlayerLink(roomId)).playerLink, describe: errorText, onChange: setState }),
  );

  // Another DM device may have changed the password, so a link on screen or on its way is fetched again rather than left to fail.
  const openedAt = useRef(accessVersion);
  useEffect(() => {
    if (accessVersion !== openedAt.current) loader.accessChanged();
  }, [accessVersion, loader]);

  return (
    <Section label="Player link">
      <Help>
        Players join with this link or its QR code, without typing anything. It carries the player password, so share
        it only with your group.
      </Help>
      {state.kind === "shown" ? (
        <>
          <PlayerLinkShare roomId={roomId} password={state.password} size="sm" />
          <Button size="sm" onClick={() => loader.hide()} style={{ justifySelf: "start" }}>
            Hide the player link
          </Button>
        </>
      ) : state.kind === "none" ? (
        <Notice role="status">
          This room's password was set before the server kept a copy it can show, or the server's key changed since.
          Change the player password once (Menu, then Members), and the player link can be shown here from then on.
        </Notice>
      ) : (
        <Button
          variant={props.main ? "primary" : "secondary"}
          size="sm"
          busy={state.kind === "loading"}
          onClick={() => void loader.show()}
          style={{ justifySelf: "start" }}
        >
          {state.kind === "loading" ? "Loading…" : "Show the player link"}
        </Button>
      )}
      {state.kind === "error" ? <ErrorText>{state.message}</ErrorText> : null}
    </Section>
  );
}

export function PlayerPassword() {
  const roomId = useRoomView((s) => s.roomId);
  const [password, setPassword] = useState(() => generatePassphrase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const problem = password.length > 0 ? passwordProblem(password) : "Enter a password.";
  return (
    <>
      {/* Remounted after a change, so a link shown before it is not left on screen. */}
      <PlayerLinkSection key={changed ?? ""} main />
      <Section label="Player password">
        <Help>
          Players join with this password, or with a player link that carries it. Changing it signs every player and
          table display out at once and stops old player links, so use it to keep a kicked player out. DM devices stay
          signed in.
        </Help>
        <Field
          label="New player password"
          value={password}
          maxLength={128}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          error={password.length > 0 ? problem : null}
          hint="At least 8 characters. Three words are easy to say out loud."
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          trailing={
            <Button size="sm" onClick={() => setPassword(generatePassphrase())} aria-label="Suggest another password">
              New
            </Button>
          }
        />
        <ConfirmAction
          label="Change the password"
          busy={busy}
          danger
          disabled={problem !== null}
          warning="Every player is signed out now and must join again with the new password or link. Table displays are signed out too and need a new code. Are you sure?"
          onConfirm={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.changePassword(roomId, password);
              setChanged(password);
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        />
        {changed ? (
          <>
            <Notice role="status">The player password changed. Old player links stop working now. Send your players this new link.</Notice>
            <PlayerLinkShare roomId={roomId} password={changed} size="sm" />
          </>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </Section>
    </>
  );
}

/** Ticks once a second while an invite is on screen and still valid, then stops. */
function useCountdown(expiresAt: string) {
  const [now, setNow] = useState(() => Date.now());
  const countdown = inviteCountdown(expiresAt, now);
  useEffect(() => {
    if (countdown.expired) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(1000, countdown.msLeft));
    return () => clearTimeout(timer);
  }, [countdown.expired, countdown.msLeft]);
  return countdown;
}

function InviteCard(props: { link: string; expiresAt: string; used: boolean; minting: boolean; onDone(): void; onAnother(): void }) {
  const countdown = useCountdown(props.expiresAt);
  const url = absoluteLink(props.link, location.origin);
  return (
    <div
      style={{
        display: "grid",
        gap: theme.space(2),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.bg,
      }}
    >
      {props.used ? (
        <>
          <Notice role="status">This invite was used: the new device is a DM device now, in the list above.</Notice>
          <div style={{ display: "flex", gap: theme.space(2) }}>
            <Button variant="primary" size="sm" onClick={props.onDone}>
              Done
            </Button>
            <Button size="sm" busy={props.minting} onClick={props.onAnother}>
              {props.minting ? "Making an invite…" : "Another invite"}
            </Button>
          </div>
        </>
      ) : countdown.expired ? (
        <>
          <Notice role="status">This invite expired. Make a new one.</Notice>
          <div style={{ display: "flex", gap: theme.space(2) }}>
            <Button variant="primary" size="sm" busy={props.minting} onClick={props.onAnother}>
              {props.minting ? "Making an invite…" : "New invite"}
            </Button>
            <Button size="sm" onClick={props.onDone}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "grid", justifyItems: "center", gap: theme.space(2) }}>
            <QrCode value={url} label="QR code of the DM device invite" />
            <strong aria-live="polite" style={{ fontVariantNumeric: "tabular-nums" }}>
              {countdown.text}
            </strong>
          </div>
          <Help>
            Scan this with the new device's camera, or send it the link. It works once, within 10 minutes, and makes that
            device a DM device. In an iPhone Home Screen app, paste the link into "Enter a DM link or invite" on the Home page.
          </Help>
          <SecretLink value={url} label="DM device invite" size="sm" />
          <Button size="sm" onClick={props.onDone} style={{ justifySelf: "start" }}>
            Done
          </Button>
        </>
      )}
    </div>
  );
}

export function DmDevices() {
  const roomId = useRoomView((s) => s.roomId);
  const members = useRoomView((s) => s.view?.members);
  const online = useRoomView((s) => s.online);
  const accessVersion = useRoomView((s) => s.accessVersion);
  const [devices, setDevices] = useState<DmDevice[] | null>(null);
  const [invites, setInvites] = useState<DmInviteState[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** What a button started and the server has not answered: one at a time, so a double tap never makes two invites. */
  const [busy, setBusy] = useState<"mint" | "other" | null>(null);
  const busyRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [invite, setInvite] = useState<{ link: string; expiresAt: string } | null>(null);
  const [newLink, setNewLink] = useState<string | null>(null);

  // The error stays until a load succeeds, so a reload that fails while offline does not make it flicker.
  const load = useCallback(async () => {
    try {
      const res = await api.listDmDevices(roomId);
      setDevices(res.devices);
      setInvites(res.invites);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [roomId]);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };
  // Asks again whenever someone comes or goes, and when the server's
  // `access` signal says a DM device was added or signed out, which is also
  // how a waiting invite's card learns it was used. It never polls (features
  // section 2).
  useEffect(() => {
    void load();
  }, [load, online, accessVersion]);
  const used = invite !== null && inviteUsed(invites, invite.expiresAt);

  const act = async (fn: () => Promise<void>, what: "mint" | "other" = "other") => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  const mint = () =>
    act(async () => {
      const res = await api.mintInvite(roomId);
      setInvite({ link: res.link, expiresAt: res.expiresAt });
    }, "mint");

  return (
    <>
      <Section label="DM devices">
        <Help>Every device signed in as a DM in this room, and every table display. Sign out any you do not recognize.</Help>
        {devices === null && !error ? <Loading text="Loading the devices…" /> : null}
        {devices?.length === 0 ? <Help>No DM devices.</Help> : null}
        {devices && devices.length > 0 ? (
          <RowList label="DM devices">
            {devices.map((d) => (
              <div key={d.sessionId} style={{ display: "grid", gap: theme.space(1), paddingBottom: theme.space(2) }}>
                <Row
                  title={d.display ? "Table display" : d.device}
                  // Wraps rather than ending in an ellipsis: who it belongs to and when it was last seen is how a DM spots a stranger.
                  detail={<span style={{ whiteSpace: "normal" }}>{`${d.display ? d.device : (members?.[d.memberId]?.name ?? "A former member")}. ${deviceSeenText(d, Date.now())}.`}</span>}
                  trailing={d.current ? <Tag tone="muted">This device</Tag> : undefined}
                />
                <div style={{ display: "grid", paddingLeft: theme.space(3) }}>
                  <ConfirmAction
                    label="Sign out"
                    busy={busy !== null}
                    danger
                    warning={
                      d.display
                        ? "Sign this table display out? It stops showing the room now. A new code from the Table display section sets it up again."
                        : d.current
                          ? "This signs this device out of DM right away. To come back you need the DM link or an invite from another DM device."
                          : "Sign this device out of DM? Its sockets close now and its unused invites stop working."
                    }
                    onConfirm={() =>
                      act(async () => {
                        await api.revokeDmDevice(roomId, d.sessionId);
                        await load();
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </RowList>
        ) : null}
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          {!invite ? (
            <Button size="sm" busy={busy === "mint"} disabled={busy !== null && busy !== "mint"} onClick={() => void mint()}>
              {busy === "mint" ? "Making an invite…" : "Add a DM device"}
            </Button>
          ) : null}
          <Button size="sm" busy={refreshing} disabled={busy !== null} onClick={() => void refresh()}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        {invite ? (
          <InviteCard
            link={invite.link}
            expiresAt={invite.expiresAt}
            used={used}
            minting={busy === "mint"}
            onAnother={() => void mint()}
            onDone={() => {
              setInvite(null);
              void load();
            }}
          />
        ) : null}
        <ErrorText>{error}</ErrorText>
      </Section>
      <Section label="DM link" tone="danger">
        {newLink ? (
          <>
            <Notice tone="warning" role="status">
              This is the new DM link. It is shown only this once. Keep it somewhere safe, like a password manager, and do
              not share it with players.
            </Notice>
            <SecretLink value={newLink} label="New DM link" size="sm" />
            <div style={{ display: "grid", justifyItems: "center" }}>
              <QrCode value={newLink} label="QR code of the new DM link" />
            </div>
            <Button size="sm" onClick={() => setNewLink(null)} style={{ justifySelf: "start" }}>
              I saved it
            </Button>
          </>
        ) : (
          <>
            <Help>
              If the DM link leaked, replace it. The old link and every unused invite stop working at once, and every other
              DM device is signed out, co-DMs included. Only this device stays a DM.
            </Help>
            <ConfirmAction
              label="Replace the DM link"
              danger
              busy={busy !== null}
              warning="Every other DM device and every co-DM loses DM right now, and the old link stops working. The new link is shown once. Replace it?"
              onConfirm={() =>
                act(async () => {
                  const res = await api.replaceDmLink(roomId);
                  setInvite(null);
                  setNewLink(absoluteLink(res.dmLink, location.origin));
                  await load();
                })
              }
            />
          </>
        )}
      </Section>
    </>
  );
}

export function DeleteRoom() {
  const roomId = useRoomView((s) => s.roomId);
  const metaName = useRoomView((s) => s.view?.meta.name ?? "");
  // The server confirms against the name stored with the room, which can
  // differ from the name in the top bar after a rename.
  const [storedName, setStoredName] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getRoom(roomId).then(
      (room) => live && setStoredName(room.name),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [roomId]);
  const name = storedName ?? metaName;
  const matches = typed.trim() !== "" && typed.trim() === name.trim();
  return (
    <Section label="Delete this room" tone="danger">
      <Help>
        Deletes the room for everyone: every scene, token, character, the log and every image. It cannot be undone.
        Download a backup first if you might want it back.
      </Help>
      <Field
        label={`Type the room name, ${name}, to confirm`}
        value={typed}
        autoComplete="off"
        onChange={(e) => {
          setTyped(e.target.value);
          setError(null);
        }}
      />
      <Button
        variant="danger"
        size="sm"
        // Typing the name is the first tap, so the button is armed once it matches.
        armed={matches}
        busy={busy}
        disabled={!matches}
        style={{ justifySelf: "start" }}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.deleteRoom(roomId, typed.trim());
            forgetRoom(roomId);
            setHomeNotice(`The room ${name.trim()} was deleted for everyone.`);
            navigate("/");
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        {busy ? "Deleting…" : "Delete room"}
      </Button>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
