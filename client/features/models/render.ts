import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Group,
  HemisphereLight,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MirroredRepeatWrapping,
  OrthographicCamera,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
  type Wrapping,
} from "three";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { boardTheme } from "../../lib/theme.ts";
import { ModelRefusal, MODEL_WORDS, type ModelColor, type ModelMesh } from "./mesh.ts";
import { frameYaw, type Fit, type Layout } from "./normalize.ts";

/**
 * Drawing a model's 8 views onto one sheet (docs/design/design-v1-token-models.md
 * 5, D-261127-168, 176, 382). It runs only in the model worker, on an
 * OffscreenCanvas, and is the only module besides the worker that loads
 * three.js (lazyThree.test.ts holds the boundary).
 *
 * The camera never moves: the model turns under it, so the lights, which
 * ride on the camera, light every frame the same way, and every frame is
 * right at every view turn. They come from the screen's upper left, as
 * Isometric's raised ground is lighter on the left, with a sky fill and a
 * faint rim from behind. Every material is matte, since without an
 * environment a metal renders near black.
 */

const L = MODEL_LIMITS;
const SHEET_W = L.framePx * L.sheetColumns;
const SHEET_H = L.framePx * L.sheetRows;

/** Stone like an unpainted mini, and the other plain colors (D-261127-175), as sRGB. */
const PLAIN_COLORS: Record<Exclude<ModelColor, `#${string}`>, number> = { stone: 0x9a968e, bronze: 0xa8743a, bone: 0xd8ccb0, iron: 0x6f7682 };

const WRAP: Record<number, Wrapping> = { 10497: RepeatWrapping, 33071: ClampToEdgeWrapping, 33648: MirroredRepeatWrapping };

/** The outline round each figure, so a grey one reads on a grey floor: how far out it reaches, in px, and how dark. */
const OUTLINE_PX = 1.5;
const OUTLINE_ALPHA = 0.7;

/** WebP where the browser encodes it, else PNG, which Safari hands back for a WebP request. */
const ENCODE = { type: "image/webp", quality: 0.92 } as const;

/** The front view's margin round the figure, as a share of its larger side. */
const FRONT_MARGIN = 0.12;

/** A plain part's color: a named material, or the picture's own as `#rrggbb`. */
export function plainColor(color: ModelColor): Color {
  if (color.startsWith("#")) return /^#[0-9a-f]{6}$/i.test(color) ? new Color(color) : new Color(PLAIN_COLORS.stone);
  return new Color(PLAIN_COLORS[color as keyof typeof PLAIN_COLORS] ?? PLAIN_COLORS.stone);
}

/**
 * A texture decoded from its bytes in the file (D-261127-476, 415): drawn
 * down to 1024 px a side, one at a time, with `createImageBitmap`, so
 * nothing is fetched and no URL is made. A browser that cannot resize as
 * it decodes draws the full decode down on a canvas. A texture that fails
 * to decode leaves its part in its base color.
 */
async function decodeTexture(bytes: Uint8Array, mime: string, width: number, height: number): Promise<ImageBitmap | null> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
  const k = Math.min(1, L.textureSidePx / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  try {
    return await createImageBitmap(blob, k < 1 ? { resizeWidth: w, resizeHeight: h, resizeQuality: "high", premultiplyAlpha: "none" } : { premultiplyAlpha: "none" });
  } catch {
    try {
      const full = await createImageBitmap(blob, { premultiplyAlpha: "none" });
      if (k >= 1) return full;
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d")?.drawImage(full, 0, 0, w, h);
      full.close();
      return await createImageBitmap(canvas);
    } catch {
      return null;
    }
  }
}

type Built = { root: Group; plain: MeshStandardMaterial[]; dispose: () => void };

/** One renderer for the worker's life, the model loaded into it, and the drawing of sheets. */
export class SheetDrawer {
  readonly #canvas: OffscreenCanvas;
  readonly #renderer: WebGLRenderer;
  readonly #scene = new Scene();
  readonly #pivot = new Group();
  readonly #camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  #built: Built | null = null;

  private constructor(canvas: OffscreenCanvas, renderer: WebGLRenderer) {
    this.#canvas = canvas;
    this.#renderer = renderer;
    renderer.setPixelRatio(1);
    renderer.setSize(SHEET_W, SHEET_H, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    this.#scene.add(this.#pivot);
    this.#scene.add(this.#camera);
    this.#scene.add(new HemisphereLight(0xf4f1ea, 0x3a3631, 1.25));
    const key = new DirectionalLight(0xffffff, 2.3);
    key.position.set(-2.2, 3, 2.2);
    const rim = new DirectionalLight(0xd8e0ff, 0.6);
    rim.position.set(2.5, 1, -2.5);
    for (const light of [key, rim]) {
      this.#camera.add(light);
      this.#camera.add(light.target);
      light.target.position.set(0, 0, -1);
    }
    // At +Z, 30 degrees up, looking at the anchor: Isometric's own camera.
    this.#camera.position.set(0, 25, 25 * Math.sqrt(3));
    this.#camera.lookAt(0, 0, 0);
  }

  /** The drawer, or the refusal for a browser without WebGL in a worker (D-261127-184). */
  static create(): SheetDrawer {
    if (typeof OffscreenCanvas === "undefined") throw new ModelRefusal(MODEL_WORDS.noWebgl);
    const canvas = new OffscreenCanvas(SHEET_W, SHEET_H);
    try {
      const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
      return new SheetDrawer(canvas, renderer);
    } catch {
      throw new ModelRefusal(MODEL_WORDS.noWebgl);
    }
  }

  /** Builds the three.js objects for a mesh, its textures decoded one at a time, replacing the last. */
  async load(mesh: ModelMesh): Promise<void> {
    this.#built?.dispose();
    this.#built = null;
    const bitmaps: (ImageBitmap | null)[] = [];
    for (const t of mesh.textures) bitmaps.push(await decodeTexture(t.bytes, t.mime, t.width, t.height));
    const root = new Group();
    root.matrixAutoUpdate = false;
    const plain: MeshStandardMaterial[] = [];
    const geometries: BufferGeometry[] = [];
    const materials: MeshStandardMaterial[] = [];
    const textures: Texture[] = [];
    for (const part of mesh.parts) {
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(part.positions, 3));
      geometry.setAttribute("normal", new BufferAttribute(part.normals, 3));
      if (part.index) geometry.setIndex(new BufferAttribute(part.index, 1));
      if (part.uvs) geometry.setAttribute("uv", new BufferAttribute(part.uvs, 2));
      if (part.colors) geometry.setAttribute("color", new BufferAttribute(part.colors, 4, true));
      const m = part.material;
      const bitmap = m.texture >= 0 ? (bitmaps[m.texture] ?? null) : null;
      let map: Texture | null = null;
      if (bitmap && part.uvs) {
        map = new Texture(bitmap);
        map.flipY = false;
        map.colorSpace = SRGBColorSpace;
        map.wrapS = WRAP[m.wrapS] ?? RepeatWrapping;
        map.wrapT = WRAP[m.wrapT] ?? RepeatWrapping;
        map.needsUpdate = true;
        textures.push(map);
      }
      const material = new MeshStandardMaterial({
        color: new Color().setRGB(m.color[0], m.color[1], m.color[2], LinearSRGBColorSpace),
        map,
        vertexColors: part.colors !== null,
        metalness: 0,
        roughness: 0.8,
        side: m.doubleSided ? DoubleSide : FrontSide,
        transparent: m.alpha === "blend",
        opacity: m.alpha === "blend" ? m.color[3] : 1,
        alphaTest: m.alpha === "mask" ? m.alphaCutoff : 0,
      });
      if (m.plain) plain.push(material);
      geometries.push(geometry);
      materials.push(material);
      root.add(new Mesh(geometry, material));
    }
    this.#pivot.add(root);
    this.#built = {
      root,
      plain,
      dispose: () => {
        this.#pivot.remove(root);
        for (const g of geometries) g.dispose();
        for (const m of materials) m.dispose();
        for (const t of textures) t.dispose();
        for (const b of bitmaps) b?.close();
      },
    };
  }

  /** The sheet and the front view at a fit and layout, the plain parts in `color`. */
  async draw(fit: Fit, layout: Layout, color: ModelColor): Promise<{ sheet: Blob; front: Blob }> {
    const built = this.#built;
    if (!built) throw new Error("no model loaded");
    for (const m of built.plain) m.color.copy(plainColor(color));
    // drawing = k × (rotation × file − offset), the offset already in the turned axes.
    const k = fit.scale * (layout.size / 100);
    const r = fit.rotation;
    const o = fit.offset;
    built.root.matrix.copy(new Matrix4().set(k * r[0], k * r[1], k * r[2], -k * o[0], k * r[3], k * r[4], k * r[5], -k * o[1], k * r[6], k * r[7], k * r[8], -k * o[2], 0, 0, 0, 1));
    built.root.matrixWorldNeedsUpdate = true;

    const camera = this.#camera;
    camera.left = -layout.side / 2;
    camera.right = layout.side / 2;
    camera.top = layout.top;
    camera.bottom = layout.top - layout.side;
    camera.updateProjectionMatrix();

    const renderer = this.#renderer;
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    const F = L.framePx;
    for (let f = 0; f < L.frames; f++) {
      this.#pivot.rotation.y = frameYaw(f);
      const col = f % L.sheetColumns;
      const row = Math.floor(f / L.sheetColumns);
      // WebGL counts rows from the bottom: the sheet's top row is frames 0 to 3.
      const y = (L.sheetRows - 1 - row) * F;
      renderer.setViewport(col * F, y, F, F);
      renderer.setScissor(col * F, y, F, F);
      renderer.render(this.#scene, camera);
    }
    renderer.setScissorTest(false);

    const sheet = outlined(this.#canvas);
    const front = frontView(sheet, layout.meta.boxes[0]!);
    return { sheet: await sheet.convertToBlob(ENCODE), front: await front.convertToBlob(ENCODE) };
  }

  dispose(): void {
    this.#built?.dispose();
    this.#built = null;
    this.#renderer.dispose();
  }
}

/**
 * The drawing with a dark outline 1.5 px out, at 70%: the drawing stamped
 * round itself, filled dark where it landed, then the drawing on top. The
 * gutter keeps each frame's outline inside it.
 */
function outlined(drawn: OffscreenCanvas): OffscreenCanvas {
  const out = new OffscreenCanvas(SHEET_W, SHEET_H);
  const ctx = out.getContext("2d")!;
  const ring = new OffscreenCanvas(SHEET_W, SHEET_H);
  const rctx = ring.getContext("2d")!;
  const d = OUTLINE_PX;
  const e = OUTLINE_PX / Math.SQRT2;
  for (const [dx, dy] of [[-d, 0], [d, 0], [0, -d], [0, d], [-e, -e], [e, e], [-e, e], [e, -e]] as const) rctx.drawImage(drawn, dx, dy);
  rctx.globalCompositeOperation = "source-in";
  rctx.globalAlpha = OUTLINE_ALPHA;
  rctx.fillStyle = boardTheme.color.stage;
  rctx.fillRect(0, 0, SHEET_W, SHEET_H);
  ctx.drawImage(ring, 0, 0);
  ctx.drawImage(drawn, 0, 0);
  return out;
}

/**
 * Frame 0, the model facing the viewer, as a square picture for a token
 * with none (D-261127-180): cropped round its drawn box with a margin, on
 * the board's raised surface color, so Top-down shows the figure large.
 */
function frontView(sheet: OffscreenCanvas, box: readonly [number, number, number, number]): OffscreenCanvas {
  const F = L.framePx;
  const [x0, y0, x1, y1] = box.map((v) => (v / L.boxMax) * F) as [number, number, number, number];
  const span = Math.min(F, Math.max(x1 - x0, y1 - y0) * (1 + 2 * FRONT_MARGIN));
  const sx = Math.min(F - span, Math.max(0, (x0 + x1) / 2 - span / 2));
  const sy = Math.min(F - span, Math.max(0, (y0 + y1) / 2 - span / 2));
  const out = new OffscreenCanvas(F, F);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = boardTheme.color.surfaceRaised;
  ctx.fillRect(0, 0, F, F);
  ctx.drawImage(sheet, sx, sy, span, span, 0, 0, F, F);
  return out;
}
