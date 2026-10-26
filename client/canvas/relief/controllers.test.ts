import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { withExplored } from "../../features/vision/exploredFog.ts";

/**
 * Both of the board's drawing trees stay mounted once Isometric has shown
 * (docs/design-v1-isometric-view.md 5.1, ISO-D15), so anything with effects
 * must mount once, outside both, or its sound, reminder, camera stream or
 * frame clock runs twice. Node cannot load the .tsx files, so these read
 * their source: the registry's lines, each renderer's own file, and where
 * the board mounts its controllers.
 */

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(CLIENT, path), "utf8");

type Entry = { id: string; iso: string; component: string };

function registry(): { layers: Entry[]; controllers: { id: string; component: string }[]; files: Map<string, string> } {
  const src = read("features/layers.ts");
  const files = new Map<string, string>();
  for (const m of src.matchAll(/import \{ ([^}]+) \} from "\.\/([^"]+)";/g)) {
    for (const name of m[1]!.split(",").map((n) => n.trim())) files.set(name, `features/${m[2]}`);
  }
  // The lazily loaded ones name their module in the loader.
  for (const m of src.matchAll(/const (\w+) = quietLazy<LayerProps>\(\(\) => import\("\.\/([^"]+)"\)/g)) files.set(m[1]!, `features/${m[2]}`);
  const list = (name: string) => src.slice(src.indexOf(`export const ${name}`), src.indexOf("];", src.indexOf(`export const ${name}`)));
  const layers = [...list("LAYERS").matchAll(/\{ id: "([^"]+)", layer: "\w+", order: \d+, iso: "(\w+)", Component: (\w+) \}/g)].map((m) => ({ id: m[1]!, iso: m[2]!, component: m[3]! }));
  const controllers = [...list("CONTROLLERS").matchAll(/\{ id: "([^"]+)", Component: (\w+) \}/g)].map((m) => ({ id: m[1]!, component: m[2]! }));
  return { layers, controllers, files };
}

/** What runs on its own: an effect, a frame loop, a store subscription or a timer. */
const EFFECTS = /\buse(Layout)?Effect\(|requestAnimationFrame\(|\.subscribe\(|setInterval\(/;

/**
 * Hooks with effects that a layer may run in both trees, each with why a
 * second run changes nothing. Anything else with effects keeps its layer
 * "off" in Isometric until its effects move into a controller.
 */
const IDEMPOTENT: Record<string, string> = {
  // Both trees publish the same pill, made from the room's data, under the same key, and the second publish finds it already there.
  usePublishPills: "the same pills under the same key",
  // Its timer only settles its own tree's "still moving" flag, which nothing outside that tree reads.
  useLiveTokens: "a timer on its own state",
  // It loads each texture once into a cache both trees share, and keeps what arrived in its own state.
  useTextures: "a shared cache read into its own state",
};

/** The source of a function or const named `name` in `src`, up to its closing line, or null. */
function bodyOf(src: string, name: string): string | null {
  const m = new RegExp(`(?:function ${name}\\b|const ${name}\\b)`).exec(src);
  if (!m) return null;
  const ends = ["\n}\n", "\n});\n", "\n};\n"].map((e) => src.indexOf(e, m.index)).filter((i) => i >= 0);
  return src.slice(m.index, ends.length > 0 ? Math.min(...ends) : undefined);
}

/** The relative imports of a file under client/: each imported name and the file it comes from. */
function importsOf(file: string): Map<string, string> {
  const src = read(file);
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import \{([^}]+)\} from "(\.{1,2}\/[^"]+)";/g)) {
    const target = join(dirname(file), m[2]!);
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().replace(/^type /, "").split(" as ")[0]!.trim();
      if (name) out.set(name, target);
    }
  }
  return out;
}

/**
 * The effects a file's code runs: in its own source, and in every hook it
 * calls that it imports from the app or defines itself, followed down
 * through the hooks those call. Each finding names the path to it.
 */
function effectsReached(file: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (where: string, code: string, trail: string) => {
    if (EFFECTS.test(code)) found.push(trail);
    const imports = importsOf(where);
    const own = read(where);
    for (const m of code.matchAll(/\b(use[A-Z]\w*)\(/g)) {
      const hook = m[1]!;
      if (IDEMPOTENT[hook]) continue;
      const from = imports.get(hook) ?? (bodyOf(own, hook) ? where : null);
      if (!from) continue;
      const key = `${from}#${hook}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const body = bodyOf(read(from), hook);
      if (body) visit(from, body, `${trail} > ${hook} (${from})`);
    }
  };
  visit(file, read(file), file);
  return found;
}

describe("the board's controllers mount once", () => {
  test("every layer names its isometric place, and every renderer whose code reaches an effect stays out of the isometric tree", () => {
    const { layers, files } = registry();
    const src = read("features/layers.ts");
    const lines = src.slice(src.indexOf("export const LAYERS"), src.indexOf("export const CONTROLLERS")).match(/\{ id: "[^"]+", layer: /g) ?? [];
    assert.equal(layers.length, lines.length, "every LAYERS line parsed");
    assert.ok(layers.length >= 20);
    for (const l of layers) {
      assert.match(l.iso, /^(ground|moving|upright|off)$/);
      const file = files.get(l.component);
      assert.ok(file, `${l.component} has a file`);
      const reached = effectsReached(file!);
      if (l.iso !== "off") assert.deepEqual(reached, [], `${l.id} reaches effects, which would run in both trees`);
    }
  });

  test("the scan follows hooks a layer imports: the trap alerts' toasts and sound, the teleport toasts and the laser's frame clock", () => {
    assert.ok(effectsReached("features/pings/LaserLayer.tsx").some((t) => t.includes("useFrameClock")));
    assert.ok(effectsReached("features/traps/useTrapAlerts.ts").length > 0);
    assert.ok(effectsReached("features/movement/toasts.ts").length > 0);
    for (const f of ["features/traps/TrapLayer.tsx", "features/movement/MoveLayer.tsx"]) assert.deepEqual(effectsReached(f), [], `${f} leaves its effects to a controller`);
  });

  test("the camera stream and the thumbnails are controllers, never layers", () => {
    const { layers, controllers } = registry();
    assert.deepEqual(
      controllers.map((c) => c.id),
      ["dm-camera", "scene-thumbnails", "trap-alerts", "teleport-toasts"],
    );
    for (const id of ["dm-camera", "scene-thumbnails"]) assert.ok(!layers.some((l) => l.id === id), `${id} drawn in a tree`);
    assert.doesNotMatch(read("features/dm/CameraLayer.tsx"), /getStage\(|react-konva/, "the camera controller reads the camera it is given, not a stage");
  });

  test("the board mounts its controllers and the ghosts' clock once, outside both drawing trees", () => {
    const stage = read("canvas/Stage.tsx");
    const iso = read("canvas/relief/IsoBoard.tsx");
    assert.equal(stage.match(/CONTROLLERS\.map\(/g)?.length, 1);
    assert.equal(stage.match(/<RemoteDragClock /g)?.length, 1);
    // Both before the first drawing tree opens.
    const firstTree = stage.indexOf("<Frozen frozen=");
    assert.ok(stage.indexOf("CONTROLLERS.map(") < firstTree && stage.indexOf("<RemoteDragClock ") < firstTree);
    assert.doesNotMatch(iso, /CONTROLLERS|RemoteDragClock|CameraController|ThumbnailLayer/);
    // The ghosts read the clock's store in both trees, and keep no clock of their own.
    const drags = read("canvas/RemoteDrags.tsx");
    const clock = drags.indexOf("export function RemoteDragClock");
    const rest = drags.slice(0, clock) + drags.slice(drags.indexOf("\n}\n", clock));
    assert.doesNotMatch(rest, /requestAnimationFrame/);
  });
});

describe("a hidden drawing tree works for nothing each frame", () => {
  test("each tree's stages hide, and the tree tells the parts that read stores", () => {
    const stage = read("canvas/Stage.tsx");
    const iso = read("canvas/relief/IsoBoard.tsx");
    const topDown = stage.slice(stage.indexOf("<TreeShownContext.Provider value={!isoShown}>"), stage.indexOf("</TreeShownContext.Provider>"));
    assert.ok(topDown.includes("<Frozen frozen={isoShown}>"), "the provider wraps Top-down's tree");
    assert.match(topDown, /<Stage[^>]*visible=\{!isoShown\}/);
    assert.equal(iso.match(/visible=\{!hidden\}/g)?.length, 2, "both isometric stages hide");
    assert.match(iso, /<TreeShownContext\.Provider value=\{!hidden\}>/);
  });

  test("the hidden isometric board reads no room changes, so a brush stroke in Top-down rebuilds nothing there", () => {
    const iso = read("canvas/relief/IsoBoard.tsx");
    const impl = iso.slice(iso.indexOf("function IsoBoardImpl("), iso.indexOf("\n}\n", iso.indexOf("function IsoBoardImpl(")));
    assert.doesNotMatch(impl, /useRoomView\(/, "every read of the room goes through useShownView");
    assert.equal(impl.match(/useShownView\(!hidden, /g)?.length, 3);
    assert.match(read("canvas/relief/context.ts"), /useRoomView\(\(s\) => \(shown \|\| !last\.current \? select\(s\) : last\.current\.value\)\)/);
  });

  test("a renderer drawn in Isometric reads the build only while its tree shows, so a brush stroke rebuilds no paths or coverage in the hidden one", () => {
    const { layers, files } = registry();
    const sources = new Set([...layers.filter((l) => l.iso !== "off").map((l) => files.get(l.component)!), "canvas/TokenShadow.tsx"]);
    for (const file of sources) assert.doesNotMatch(read(file), /useRoomView\([^;]*\bbuildChunks\b/, `${file} reads the build through useTreeShownView`);
    assert.match(read("canvas/relief/context.ts"), /return useShownView\(useTreeShown\(\), select\);/);
    // A trap's name pill sits on its door, and both trees publish it under one key, so the hidden tree holds the traps with the build.
    assert.match(read("features/traps/TrapLayer.tsx"), /const traps = useTreeShownView\(\(s\) => s\.view\?\.traps /);
  });

  test("ghosts and shadows read no drag while their tree is hidden", () => {
    assert.match(read("canvas/RemoteDrags.tsx"), /useRoomView\(\(s\) => \(shown \? s\.ephemeral\.drags : NO_DRAGS\)\)/);
    assert.match(read("canvas/TokenShadow.tsx"), /\(shown \? s\.spots\[token\.id\] : undefined\)/);
  });

  test("a ghost's frame redraws the drag layer, never the overlay with its text", () => {
    const iso = read("canvas/relief/IsoBoard.tsx");
    const main = iso.slice(iso.indexOf("<Stage key={`main:"));
    const [relief, drag, overlay, ...rest] = main.split(/<Layer[ >]/).slice(1);
    assert.equal(rest.length, 0, "the main stage holds three layers");
    assert.match(relief!, /ReliefRun/);
    for (const part of [/part="ghost"/, /part="tag"/, /MOVING_LAYERS\.map/]) assert.match(drag!, part);
    assert.doesNotMatch(overlay!, /RemoteDrags|MOVING_LAYERS/);
    assert.match(overlay!, /UprightLabels/);
  });
});

describe("both trees share one map image", () => {
  test("the board loads the map once, above both trees, and a tree's map layer loads its own only outside the board", () => {
    const stage = read("canvas/Stage.tsx");
    const wrap = stage.indexOf("<SharedMapImage scene={scene} variant={variant}>");
    assert.ok(wrap > 0 && wrap < stage.indexOf("<Frozen frozen=") && stage.indexOf("</SharedMapImage>") > stage.indexOf("<IsoBoard"), "it wraps both trees");
    const map = read("canvas/layers/MapLayer.tsx");
    assert.match(map, /const own = useMapImage\(shared \? null : source\.url, source\.fallback\);/);
    assert.match(map, /shared \? \(shared\.url === source\.url \? shared\.state : LOADING\) : own/);
    assert.equal(map.match(/useMapImage\(/g)?.length, 2, "the shared loader and the fallback, nothing else");
  });

  test("only the tree on screen reports the map's progress", () => {
    assert.match(read("canvas/Stage.tsx"), /<MapLayer scene=\{scene\} variant=\{variant\} report=\{!isoShown\} \/>/);
    assert.match(read("canvas/relief/IsoBoard.tsx"), /<MapContent scene=\{scene\} variant=\{props\.variant\} report=\{!hidden\}/);
  });
});

describe("map labels in Isometric", () => {
  test("the board splits them once, the ground's build leaves out what stands by id, and an upright one draws from labelShape's box", () => {
    const iso = read("canvas/relief/IsoBoard.tsx");
    const builder = read("features/builder/BuilderLayer.tsx");
    assert.equal(iso.match(/splitLabels\(/g)?.length, 1);
    assert.doesNotMatch(builder, /splitLabels\(/);
    assert.match(builder, /labels\.filter\(\(l\) => !iso\.uprightLabels\.has\(l\.id\)\)/);
    assert.match(iso, /uprightLabels: uprightIds/);
    assert.match(iso, /labelShape\(l, view, \{ measure: measureLabel, upright: true, ground: ground\(l\.x, l\.y\) \}\)/);
  });
});

describe("the isometric board's lookups", () => {
  test("standees are found by id in a map, never by searching the list", () => {
    assert.doesNotMatch(read("canvas/relief/IsoBoard.tsx"), /standees\.find\(/);
  });
});

describe("every isometric place draws", () => {
  test("a layer on the ground, moving or upright draws in Isometric, whichever layer of Top-down it came from", () => {
    const iso = read("canvas/relief/IsoBoard.tsx");
    assert.match(iso, /const GROUND_LAYERS = isoLayersOf\("ground", "board"\);/);
    assert.match(iso, /const GROUND_MARKS = \[\.\.\.isoLayersOf\("ground", "underDecor"\), \.\.\.isoLayersOf\("ground", "overlay"\)\];/);
    assert.match(iso, /const MOVING_LAYERS = isoLayersOf\("moving"\);/);
    assert.match(iso, /const UPRIGHT_LAYERS = isoLayersOf\("upright"\);/);
    for (const list of ["GROUND_LAYERS", "GROUND_MARKS", "MOVING_LAYERS", "UPRIGHT_LAYERS"]) assert.match(iso, new RegExp(`\\{${list}\\.map\\(`), `${list} is drawn`);
    // The upright ones in the overlay, in view space.
    const main = iso.slice(iso.indexOf("<Stage key={`main:"));
    const overlay = main.split(/<Layer[ >]/)[3]!;
    assert.match(overlay, /UPRIGHT_LAYERS\.map\(/);
  });
});

describe("the ground stage hides what Top-down hides (5.2, 12)", () => {
  test("flat creatures draw before the fog, and the ground marks after it, as Top-down's layers order them", () => {
    const iso = read("canvas/relief/IsoBoard.tsx");
    const ground = iso.slice(iso.indexOf("<Stage\n          key={`ground:"), iso.indexOf("<Stage key={`main:"));
    const at = (needle: string) => {
      const i = ground.indexOf(needle);
      assert.ok(i >= 0, `${needle} on the ground stage`);
      return i;
    };
    const order = ["<MapContent ", "{GROUND_LAYERS.map(", "{flat.map((t) => props.renderToken(t, null))}", "<SightOverlay ", "<FogShape ", "{GROUND_MARKS.map("].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "map, board layers, flat creatures, sight, fog, then ground marks");
    // Top-down's tree the same way: the tokens under the fog draw before it, in their own layer.
    const stage = read("canvas/Stage.tsx");
    assert.ok(stage.indexOf("{below.map((t) => renderToken(t))}") < stage.indexOf("<FogShape sceneId={scene.id}"));
  });

  test("a player's stand rule reads the very tiles their fog draws from", () => {
    const stage = read("canvas/Stage.tsx");
    assert.match(stage, /viewerFog=\{role === "player" && fog \? fogTiles : null\}/);
    assert.match(stage, /const drawnFogTiles = useDrawnFogTiles\(fogTiles, role\);/);
    assert.match(read("features/vision/stageHooks.ts"), /const explored = useRoomView\(\(s\) => \(role === "dm" \? s\.view\?\.exploredTiles : undefined\)\);/);
    // With no explored tiles, which only the DM reads, the drawn fog is the fog itself.
    const tiles = {};
    assert.equal(withExplored(tiles, undefined), tiles);
  });
});

describe("the board's view (ISO-5's hooks)", () => {
  test("the test hook picks for the display by the view it is given, not by its camera, which comes later", () => {
    assert.match(read("canvas/Stage.tsx"), /useIsoTestHook\(props\.view !== undefined \? displayViewKey\(roomId\) : viewKey\(roomId\), scene\.id\);/);
  });

  test("the board shows Top-down while Isometric is not offered, even with Isometric stored as this device's pick", async () => {
    const { isoOffered } = await import("../../features/view/choice.ts");
    const { shownView, isoReady } = await import("../../features/view/store.ts");
    const { TOP_DOWN } = await import("../../lib/view.ts");
    assert.equal(isoReady, false);
    assert.equal(isoOffered, false, "no page here sets the test flag");
    const stored = { v: 1 as const, pick: "isometric" as const, turns: { s1: 2 as const } };
    assert.equal(shownView({ stored, sceneId: "s1", suggested: "isometric", ready: isoOffered }), TOP_DOWN);
    // The room's choice passes isoOffered as `ready`, and the board draws that choice.
    assert.match(bodyOf(read("features/view/ViewMenu.tsx"), "useViewChoice")!, /ready: isoOffered/);
    assert.match(read("canvas/Stage.tsx"), /const shown: View = props\.view \?\? roomChoice\.shown;/);
  });

  test("on a table display the room's choice, which the board reads and ignores, runs no effects, writes nothing and says nothing", () => {
    const menu = read("features/view/ViewMenu.tsx");
    for (const hook of ["useRoomViewChoice", "useViewChoice"]) {
      const body = bodyOf(menu, hook)!;
      assert.doesNotMatch(body, EFFECTS, `${hook} runs no effect`);
      assert.doesNotMatch(body, /sayView\(|useViewVoice\(/, `${hook} says nothing`);
      // It writes only from its pick and turn, which nothing on the board calls.
      assert.doesNotMatch(body.replace(/const (pick|turn) = [\s\S]*?\n  \};\n/g, ""), /pickView\(|turnView\(|setState\(/, `${hook} writes nothing as it reads`);
    }
    assert.doesNotMatch(bodyOf(read("features/view/store.ts"), "useStoredView")!, EFFECTS);
    const stage = read("canvas/Stage.tsx");
    assert.doesNotMatch(stage, /useViewVoice\(|roomChoice\.(pick|turn)\(/);
  });
});
