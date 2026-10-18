import {
  CanvasTexture,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Texture,
} from "three";
import { theme } from "../../../lib/theme.ts";
import { seededRandom, TRAY_PX, type DieKind } from "./layout.ts";
import { buildModel, cellOf, faceLocal, landing, MAX_TILT, shownFace, type DieModel } from "./models.ts";
import { LAND_MS, LAST_FRAME_MS, pathFor, poseAt, type DiePath } from "./poses.ts";
import { contextAttributes } from "./probe.ts";
import { diceSet, type DiceSet } from "./sets.ts";
import type { Stage, StagedThrow, StageEvents } from "./store.ts";

/**
 * The dice drawn (docs/design-v1-roll-animation.md 5 to 9): the renderer
 * on its own canvas and context, each kind's texture and the result's
 * decal drawn in code with Inter, a pool of meshes per kind, and the loop
 * that runs only while dice move. This is the lazy chunk's entry: the
 * store reaches it by `import()`, so three loads only once the room is
 * ready and only where the dice can be drawn.
 *
 * The scene is lit as the prototype was: a soft sky light and a key light
 * from the upper left over flat faces. The camera is orthographic in the
 * tray's screen px, y upward, so a die's size on screen is its slot's.
 */

/** The dice and the scrim fade out from here to GONE_MS (store.ts), on the compositor. */
const FADE_FROM_MS = 1800;
const GONE_MS = 2100;
const FADE_IN_MS = 170;

/** A cube's outline is its face, not its corners, so it scales up to fill its slot as the others do. */
const CUBE_FILL = 1.15;

const models = new Map<DieKind, { model: DieModel; edges: EdgesGeometry }>();

function modelOf(kind: DieKind): { model: DieModel; edges: EdgesGeometry } {
  let made = models.get(kind);
  if (!made) {
    const model = buildModel(kind);
    made = { model, edges: new EdgesGeometry(model.geometry, 20) };
    models.set(kind, made);
  }
  return made;
}

/** Dice of eight sides or more underline their 6 and 9, which a tilted face could read either way. A d6 does not. */
function underlines(kind: DieKind): boolean {
  return kind !== "d4" && kind !== "d6" && kind !== "coin";
}

/**
 * Inter, the app's bundled font, before any number is drawn: load()
 * rejects when Inter fails, and the numbers are then drawn with the same
 * fallback the interface shows.
 */
let fontReady: Promise<void> | null = null;
function fonts(): Promise<void> {
  fontReady ??= document.fonts.load(`${theme.weight.bold} 64px Inter`).then(
    () => undefined,
    () => undefined,
  );
  return fontReady;
}

/** One number, centered at a point of a 2D canvas and turned to read along `up` (x right, y up). */
function drawLabel(g: CanvasRenderingContext2D, text: string, at: { x: number; y: number }, up: [number, number], px: number, color: string, underline: boolean, maxWidth: number): void {
  g.save();
  g.translate(at.x, at.y);
  g.rotate(Math.atan2(up[0], up[1]));
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  let size = px * (text.length > 1 ? 0.78 : 1);
  g.font = `${theme.weight.bold} ${size}px ${theme.font.body}`;
  // A coin's 1,000 is drawn smaller rather than run past its face.
  const width = g.measureText(text).width;
  if (width > maxWidth) {
    size *= maxWidth / width;
    g.font = `${theme.weight.bold} ${size}px ${theme.font.body}`;
  }
  g.fillText(text, 0, size * 0.04);
  if (underline && (text === "6" || text === "9")) g.fillRect(-size * 0.22, size * 0.42, size * 0.44, size * 0.08);
  g.restore();
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** A kind's texture in a set: the body color, and every face's number in the set's faint ink. */
function drawAtlas(model: DieModel, set: DiceSet): CanvasTexture {
  const { cols, rows, cell } = model.atlas;
  const canvas = document.createElement("canvas");
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const g = canvas.getContext("2d")!;
  g.fillStyle = set.body;
  g.fillRect(0, 0, canvas.width, canvas.height);
  if (model.kind !== "coin") {
    model.labeled.forEach((f, k) => {
      const { cx, cy, half } = cellOf(k, cols, cell);
      for (const l of f.labels) {
        const [x, y] = faceLocal(f, l.at);
        drawLabel(g, model.labels[l.value]!, { x: cx + x * half, y: cy - y * half }, [l.up.dot(f.right), l.up.dot(f.up)], l.size * half, set.faint, underlines(model.kind), cell * 0.9);
      }
    });
  }
  return canvasTexture(canvas);
}

/** The body's material for a set's finish, all in three's core: no environment map, no second pass. */
function bodyMaterial(set: DiceSet, map: Texture): MeshLambertMaterial | MeshPhongMaterial {
  const base = { map, flatShading: true, transparent: true };
  if (set.finish === "matte") return new MeshLambertMaterial(base);
  if (set.finish === "glossy") return new MeshPhongMaterial({ ...base, shininess: 80, specular: 0x666666 });
  // Metal without an environment map: a darker body under a bright highlight in the edge's color.
  if (set.finish === "metal") return new MeshPhongMaterial({ ...base, color: 0xc4c4c4, shininess: 40, specular: new Color(set.edge) });
  // Translucent: the back faces are not drawn, so no number shows through from behind.
  return new MeshPhongMaterial({ ...base, opacity: 0.86, shininess: 100, specular: 0x888888 });
}

function bodyOpacity(set: DiceSet): number {
  return set.finish === "translucent" ? 0.86 : 1;
}

type PoolDie = {
  kind: DieKind;
  group: Group;
  mesh: Mesh;
  body: MeshLambertMaterial | MeshPhongMaterial;
  edge: LineBasicMaterial;
  decal: Mesh<PlaneGeometry, MeshBasicMaterial>;
  set: string;
};

/** A die of the throw on screen: its pooled meshes, its path and what it lands showing. */
type Thrown = { die: PoolDie; path: DiePath; base: number; kept: boolean; opacity: number };

/** Lays a decal flat on a face, a hair above it, reading along `up`. */
function placeOn(mesh: Mesh, at: Vector3, normal: Vector3, up: Vector3): void {
  mesh.position.copy(at).addScaledVector(normal, 0.004);
  mesh.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3().crossVectors(up, normal).normalize(), up, normal));
}

export function createStage(events: StageEvents): Stage | null {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.diceStage = "";
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.zIndex = "1";
  canvas.style.pointerEvents = "none";
  canvas.style.display = "none";
  // At most 2 device pixels per screen pixel, and antialiasing only below 2.
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const antialias = ratio < 2;
  const context = canvas.getContext("webgl2", contextAttributes(antialias));
  if (!context) return null;
  let deliberate = false;
  canvas.addEventListener("webglcontextlost", () => events.lost(deliberate));
  canvas.addEventListener("webglcontextrestored", () => events.restored());
  const renderer = new WebGLRenderer({ canvas, context, antialias, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(1);
  renderer.setSize(1, 1);

  const scene = new Scene();
  scene.add(new HemisphereLight(0xffffff, 0x8a8577, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.5);
  sun.position.set(-0.25, 0.45, 1);
  scene.add(sun);
  const camera = new OrthographicCamera(0, 1, 0, -1, -500, 500);

  const atlases = new Map<string, CanvasTexture>();
  const decals = new Map<string, CanvasTexture>();
  const pool = new Map<DieKind, PoolDie[]>();
  const plane = new PlaneGeometry(1, 1);

  const atlasOf = (kind: DieKind, set: DiceSet) => {
    const key = `${set.id}|${kind}`;
    let atlas = atlases.get(key);
    if (!atlas) {
      atlas = drawAtlas(modelOf(kind).model, set);
      atlases.set(key, atlas);
    }
    return atlas;
  };

  /** The result's own number in the set's full ink, which darkens as the die arrives. */
  const decalOf = (text: string, set: DiceSet, underline: boolean) => {
    const key = `${text}|${set.ink}|${underline}`;
    let texture = decals.get(key);
    if (!texture) {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      drawLabel(c.getContext("2d")!, text, { x: 64, y: 64 }, [0, 1], 128, set.ink, underline, 120);
      texture = canvasTexture(c);
      decals.set(key, texture);
    }
    return texture;
  };

  /** Moves and relabels pooled meshes rather than making new ones, so a throw's setup stays a few ms. */
  const acquire = (kind: DieKind, set: DiceSet, index: number): PoolDie => {
    const dice = pool.get(kind) ?? [];
    pool.set(kind, dice);
    let die = dice[index];
    if (!die) {
      const { model, edges } = modelOf(kind);
      const body = bodyMaterial(set, atlasOf(kind, set));
      const mesh = new Mesh(model.geometry, body);
      const edge = new LineBasicMaterial({ color: set.edge, transparent: true });
      mesh.add(new LineSegments(edges, edge));
      const decal = new Mesh(plane, new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      mesh.add(decal);
      const group = new Group();
      group.add(mesh);
      group.visible = false;
      scene.add(group);
      die = { kind, group, mesh, body, edge, decal, set: set.id };
      dice[index] = die;
    }
    if (die.set !== set.id) {
      die.body.dispose();
      die.body = bodyMaterial(set, atlasOf(kind, set));
      die.mesh.material = die.body;
      die.edge.color.set(set.edge);
      die.set = set.id;
    }
    return die;
  };

  const hideAll = () => {
    for (const dice of pool.values()) for (const d of dice) d.group.visible = false;
  };

  let thrown: Thrown[] = [];
  let set = diceSet("ivory");
  let raf = 0;
  let startedAt = 0;
  let frames = 0;
  let landedRead = false;
  let fade: Animation | null = null;

  /** What each landed die shows the camera, read back from its pose: the stage's test hook, `data-landed`. */
  const readLanded = () =>
    thrown
      .map((t) => {
        const { model } = modelOf(t.die.kind);
        const q = t.die.group.quaternion;
        if (model.kind === "coin") return t.die.decal.userData.text as string;
        if (model.kind === "d4") {
          // A d4 is read by its top corner: the highest of the face toward the viewer.
          const face = model.faces.reduce((a, b) => (b.normal.clone().applyQuaternion(q).z > a.normal.clone().applyQuaternion(q).z ? b : a));
          const top = face.corners.reduce((a, b) => (b.clone().applyQuaternion(q).y > a.clone().applyQuaternion(q).y ? b : a));
          return model.labels[model.corners.findIndex((c) => c.distanceTo(top) < 1e-4)] ?? "";
        }
        const face = model.faces.reduce((a, b) => (b.normal.clone().applyQuaternion(q).z > a.normal.clone().applyQuaternion(q).z ? b : a));
        return model.labels[face.value] ?? "";
      })
      .join(" ");

  const draw = (ms: number) => {
    for (const t of thrown) {
      const pose = poseAt(t.path, ms, !t.kept);
      t.die.group.position.copy(pose.position);
      t.die.group.quaternion.copy(pose.quaternion);
      t.die.group.scale.setScalar(t.base * pose.scale);
      t.die.decal.material.opacity = pose.reveal * pose.opacity;
      t.die.body.opacity = t.opacity * pose.opacity;
      t.die.edge.opacity = pose.opacity;
    }
    renderer.render(scene, camera);
    frames++;
    canvas.dataset.frames = String(frames);
    if (!landedRead && ms >= LAND_MS) {
      landedRead = true;
      canvas.dataset.landed = readLanded();
    }
  };

  const tick = (now: number) => {
    const ms = now - startedAt;
    draw(Math.min(ms, LAST_FRAME_MS));
    raf = ms < LAST_FRAME_MS ? requestAnimationFrame(tick) : 0;
  };

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    fade?.cancel();
    fade = null;
    canvas.style.display = "none";
    hideAll();
    thrown = [];
    // At rest the drawing buffer shrinks to one pixel. The shaders and textures stay.
    renderer.setPixelRatio(1);
    renderer.setSize(1, 1);
  };

  return {
    async warm(kinds, setId) {
      await fonts();
      set = diceSet(setId);
      // One die of each kind in the scene, so its shader compiles and its texture uploads now, not on the first throw.
      const dice = kinds.map((kind) => acquire(kind, set, 0));
      const atlasList = kinds.map((kind) => atlasOf(kind, set));
      for (const d of dice) {
        d.group.visible = true;
        d.decal.material.map = decalOf("20", set, true);
      }
      renderer.compile(scene, camera);
      for (const atlas of atlasList) renderer.initTexture(atlas);
      if (!raf) hideAll();
    },

    play(t: StagedThrow) {
      stop();
      set = diceSet(t.set);
      const parent = t.parent as HTMLElement | null;
      if (parent && canvas.parentElement !== parent) parent.appendChild(canvas);
      const { width, height, zoom } = t.geometry;
      // The canvas's CSS size is its screen size over the panel's zoom, and its pixels are neither blurred at 130% nor oversampled at 85%.
      renderer.setPixelRatio(ratio * zoom);
      renderer.setSize(width / zoom, height / zoom);
      camera.left = 0;
      camera.right = width;
      camera.top = 0;
      camera.bottom = -height;
      camera.updateProjectionMatrix();
      const random = seededRandom(`${t.tag}:paths`);
      const from = t.geometry.from ?? { x: width, y: TRAY_PX };
      const counts = new Map<DieKind, number>();
      thrown = t.plan.slots.map((slot, index) => {
        const kind = slot.die.kind;
        const n = counts.get(kind) ?? 0;
        counts.set(kind, n + 1);
        const die = acquire(kind, set, n);
        const { model } = modelOf(kind);
        const shown = shownFace(model, slot.die.value);
        const decalSize = model.kind === "coin" ? 1.2 : (shown.label?.size ?? 0.8) * shown.face.size;
        die.decal.material.map = decalOf(slot.die.text, set, underlines(kind) && model.kind !== "coin");
        die.decal.material.needsUpdate = true;
        die.decal.scale.setScalar(decalSize);
        die.decal.userData.text = slot.die.text;
        placeOn(die.decal, shown.label?.at ?? shown.face.center, shown.face.normal, shown.up);
        die.group.visible = true;
        const path = pathFor({ from: { x: from.x, y: -from.y }, to: { x: slot.x, y: -slot.y }, landing: landing(model, slot.die.value, (random() - 0.5) * 2 * MAX_TILT), index }, random);
        return { die, path, base: (slot.size / 2) * (kind === "d6" ? CUBE_FILL : 1), kept: slot.die.kept, opacity: bodyOpacity(set) };
      });
      frames = 0;
      landedRead = false;
      delete canvas.dataset.landed;
      canvas.style.display = "block";
      startedAt = performance.now();
      if (t.reduced) {
        // Reduced motion: the dice drawn once, already at rest, fading in.
        draw(LAST_FRAME_MS);
        fade = canvas.animate([{ opacity: 0 }, { opacity: 1, offset: FADE_IN_MS / GONE_MS }, { opacity: 1, offset: FADE_FROM_MS / GONE_MS }, { opacity: 0 }], { duration: GONE_MS, fill: "forwards" });
        return;
      }
      fade = canvas.animate([{ opacity: 1 }, { opacity: 1, offset: FADE_FROM_MS / GONE_MS }, { opacity: 0 }], { duration: GONE_MS, fill: "forwards" });
      raf = requestAnimationFrame(tick);
    },

    stop,

    dispose() {
      deliberate = true;
      stop();
      for (const dice of pool.values()) {
        for (const d of dice) {
          d.body.dispose();
          d.edge.dispose();
          d.decal.material.dispose();
        }
      }
      pool.clear();
      for (const texture of [...atlases.values(), ...decals.values()]) texture.dispose();
      atlases.clear();
      decals.clear();
      plane.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
