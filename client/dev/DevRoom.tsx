import { useEffect, useMemo, useState } from "react";
import type { Viewer } from "#shared/model.ts";
import type { EphEvent } from "#shared/protocol.ts";
import type { AssetVariant } from "../lib/api.ts";
import { theme } from "../lib/theme.ts";
import { Room } from "../pages/Room.tsx";
import { createRoomActions } from "../state/actions.ts";
import { browserEnv, createRoomSocket, type ConnectionEnv } from "../state/socket.ts";
import { createRoomStore, type RoomStore } from "../state/store.ts";
import type { RoomActions } from "../state/types.ts";
import { RoomProvider, type AssetSource } from "../state/view.ts";
import { visionFixture } from "../features/vision/devFixture.ts";
import { createFixtureState, FIXTURE_IDS, type FixtureOptions } from "./fixture.ts";
import { LocalServer, localSocketFactory } from "./localServer.ts";
import { drawMap, drawPortrait } from "./placeholders.ts";

/**
 * The Room page on fixture data, at `/dev/room` in development only. It
 * runs the real store and socket against a LocalServer in the page, so ops,
 * acks, refusals, reconnects and previews all take their production paths.
 *
 * Query parameters:
 * - `as=player` shows Thorn's projection instead of the DM's view.
 * - `conn=down` never connects. `conn=offline` also reports the browser offline.
 * - `snapshot=late` delays every snapshot by 2 s, to watch the gate.
 * - `fog=off|corrupt|none` turns fog off, corrupts every tile, or sends no tiles.
 * - `blackout=1` turns on the players' blackout.
 * - `areas=1` places a cone of the DM's and one of Vex's.
 * - `walls=1` adds free walls, doors and a window off the grid, and lights, to the cave.
 * - `ghost=1` has Vex drag Goblin 1 around every few seconds, to watch remote previews.
 * - `sight=1` makes the cave a dark vision scene with the walls and lights of `walls=1` (features/vision/devFixture.ts), seen by the real sight rules.
 * - `color=8e4ec6` gives the viewer that member color, to watch the accent follow it (lib/accent.ts).
 * - `text=1` puts board text at its worst: long names, packed crowds, long area and map labels.
 * - `melee=1` casts Spirit Guardians around Thorn with goblins in melee above and below him.
 * - `pcstats=1` gives Thorn a level and a stat block (docs/design-v1-pc-stats.md).
 * - `ask=save|check|two` opens a roll request for Thorn and Vex, Thorn Restrained and Blessed for a save, and `ask=saveends` a save-ends request of Thorn's with a rolled fail and a pending ask (docs/design-v1-roll-request.md 5, 1.1).
 * - `rolls=1` links the goblins to the SRD's Goblin Warrior, for the Dice panel's roll options (docs/design-v1-roll-options.md).
 * - `party=1` adds six players' characters with long names to the party, two of them off the scene (docs/design-v1-side-headers.md).
 */
function readOptions() {
  const q = new URLSearchParams(location.search);
  const fog = q.get("fog");
  const conn = q.get("conn");
  const color = q.get("color");
  return {
    role: q.get("as") === "player" ? ("player" as const) : ("dm" as const),
    down: conn === "down" || conn === "offline",
    offline: conn === "offline",
    late: q.get("snapshot") === "late",
    ghost: q.get("ghost") === "1",
    sight: q.get("sight") === "1",
    color: color && /^[0-9a-f]{6}$/i.test(color) ? `#${color.toLowerCase()}` : null,
    fixture: {
      fog: fog === "off" || fog === "corrupt" || fog === "none" ? fog : "normal",
      blackout: q.get("blackout") === "1",
      areas: q.get("areas") === "1",
      walls: q.get("walls") === "1" || q.get("sight") === "1",
      text: q.get("text") === "1",
      melee: q.get("melee") === "1",
      pcstats: q.get("pcstats") === "1",
      ...(q.get("ask") === "save" || q.get("ask") === "check" || q.get("ask") === "two" || q.get("ask") === "saveends" ? { ask: q.get("ask") as "save" | "check" | "two" | "saveends" } : {}),
      rolls: q.get("rolls") === "1",
      party: q.get("party") === "1",
    } satisfies FixtureOptions,
  };
}

async function placeholderAssets(): Promise<AssetSource> {
  const [full, mobile, thorn, goblin, owlbear] = await Promise.all([
    drawMap(1),
    drawMap(0.5),
    drawPortrait("T", "#1d4ed8", "#60a5fa"),
    drawPortrait("G", "#365314", "#84cc16"),
    drawPortrait("O", "#78350f", "#d97706"),
  ]);
  const urls: Record<string, string> = {
    "fixture-map:full": full,
    "fixture-map:mobile": mobile,
    "fixture-thorn": thorn,
    "fixture-goblin": goblin,
    "fixture-owlbear": owlbear,
  };
  return { url: (id: string, variant: AssetVariant) => urls[`${id}:${variant}`] ?? urls[id] ?? `/missing/${id}` };
}

type Dev = { room: RoomStore; actions: RoomActions; drop(): void };

export default function DevRoom() {
  const options = useMemo(readOptions, []);
  const [assets, setAssets] = useState<AssetSource | null>(null);
  const [dev, setDev] = useState<Dev | null>(null);

  useEffect(() => {
    const viewer: Viewer = { memberId: options.role === "dm" ? FIXTURE_IDS.dm : FIXTURE_IDS.thorn, role: options.role };
    const fixture = createFixtureState(options.fixture);
    const state = options.sight ? visionFixture(fixture, FIXTURE_IDS.cave) : fixture;
    const you = state.members[viewer.memberId];
    if (options.color && you) you.color = options.color;
    const server = new LocalServer(state, viewer, FIXTURE_IDS.cave);
    const online = [FIXTURE_IDS.dm, FIXTURE_IDS.thorn, ...(options.ghost ? [FIXTURE_IDS.vex] : [])];
    const sockets = localSocketFactory({
      server,
      snapshotDelayMs: options.late ? 2000 : 0,
      down: () => options.down,
      members: () => online,
    });
    const env: ConnectionEnv = options.offline ? { isOnline: () => false, subscribe: () => () => {} } : browserEnv();
    const room = createRoomStore({ roomId: "DEVR00M0", you: viewer });
    const socket = createRoomSocket({ url: "local", room, env, createSocket: sockets.create });
    socket.start();
    const stopGhost = options.ghost ? startGhost(server, sockets.push) : () => {};
    setDev({ room, actions: createRoomActions(room, socket), drop: sockets.drop });
    // For poking at the fixture from the browser console.
    Object.assign(window, { raccoonDev: { room, server, socket } });
    return () => {
      stopGhost();
      socket.dispose();
      room.dispose();
      setDev(null);
    };
  }, [options]);

  useEffect(() => {
    void placeholderAssets().then(setAssets);
  }, []);

  if (!assets || !dev) return null;
  return (
    <RoomProvider store={dev.room.store} actions={dev.actions} ui={dev.room.ui} assets={assets}>
      <Room />
      <FixtureMenu onDrop={dev.drop} />
    </RoomProvider>
  );
}

/**
 * Vex drags Goblin 1 in a loop: preview frames at 30 a second, a drop, then
 * the committed move, the way another phone at the table would.
 */
function startGhost(server: LocalServer, push: ReturnType<typeof localSocketFactory>["push"]): () => void {
  const tokenId = "t-03";
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  const send = (e: EphEvent) => push({ t: "eph", from: FIXTURE_IDS.vex, e });
  const run = () => {
    const token = server.state.tokens[tokenId];
    if (!token) return;
    const from = { x: token.x, y: token.y };
    const to = { x: from.x === 12 ? 14 : 12, y: from.y === 6 ? 8 : 6 };
    send({ k: "dragStart", tokenId, x: from.x, y: from.y });
    const frames = 45;
    for (let i = 1; i <= frames; i++) {
      later((i * 1000) / 30, () => {
        const f = i / frames;
        const wobble = Math.sin(f * Math.PI) * 1.5;
        send({ k: "dragMove", tokenId, x: from.x + (to.x - from.x) * f + wobble, y: from.y + (to.y - from.y) * f });
      });
    }
    later(1600, () => send({ k: "dragEnd", tokenId, ...to }));
    later(1660, () => {
      const ev = server.external({ t: "token.move", tokenId, ...to }, { memberId: FIXTURE_IDS.dm, role: "dm" });
      if (ev) push(ev);
    });
    later(5000, run);
  };
  later(1500, run);
  return () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}

function FixtureMenu(props: { onDrop(): void }) {
  const links: [string, string][] = [
    ["DM view", "/dev/room"],
    ["Player view", "/dev/room?as=player"],
    ["Player, late snapshot", "/dev/room?as=player&snapshot=late"],
    ["Player, corrupt fog", "/dev/room?as=player&fog=corrupt"],
    ["Player, blackout", "/dev/room?as=player&blackout=1"],
    ["Player, Vex dragging", "/dev/room?as=player&ghost=1"],
    ["Fog off", "/dev/room?fog=off"],
    ["Vision, DM", "/dev/room?sight=1"],
    ["Vision, player", "/dev/room?as=player&sight=1"],
    ["Never connects", "/dev/room?conn=down"],
    ["Offline", "/dev/room?conn=offline"],
  ];
  return (
    <details
      style={{
        position: "fixed",
        left: 8,
        top: "calc(env(safe-area-inset-top, 0px) + 60px)",
        zIndex: 30,
        background: theme.color.overlay,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.md,
        padding: "4px 10px",
        fontSize: theme.font.small,
        color: theme.color.text,
      }}
    >
      <summary style={{ cursor: "pointer", minHeight: 28, lineHeight: "28px" }}>Fixture</summary>
      <ul style={{ margin: 0, padding: "4px 0 6px 16px" }}>
        {links.map(([label, href]) => (
          <li key={href}>
            <a href={href} style={{ color: theme.color.accent }}>
              {label}
            </a>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={props.onDrop}
            style={{ background: "none", border: "none", padding: 0, color: theme.color.accent, font: "inherit", cursor: "pointer" }}
          >
            Drop the connection
          </button>
        </li>
      </ul>
    </details>
  );
}
