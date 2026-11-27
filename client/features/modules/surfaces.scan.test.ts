import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { clientSources, REPO_ROOT, scanControlSites, type Sources } from "./controlSites.ts";
import { isModuleId } from "./registry.ts";
import { PRIMITIVES, SURFACES } from "./surfaces.ts";

/*
 * The control-site scan (docs/design/design-v1-features.md 14, checks 5 and
 * 6). The parts markup test checks only the surfaces it draws, so a control
 * added where no drawing looks would escape it, and a gate is no help in
 * finding the controls nobody gated. So the source is scanned for every
 * control site, gates unread (D-261127-420), and surfaces.ts must place each
 * file that holds one, with its count: a new control anywhere, in any
 * branch, fails here until someone decides where it is checked. The
 * primitives are computed, so a new wrapper around a control counts the day
 * it is written, and fails here until it is placed on purpose (D-261127-426).
 */

const scan = scanControlSites(clientSources());

/** Check 6's runtime gates, which draw no control and are checked by their own tests (D-261127-422). */
const RUNTIME_GATES = [
  "client/features/pings/PingController.ts",
  "client/features/sound/engine/SoundHost.tsx",
  "client/features/sound/engine/useSoundAsk.ts",
  "client/features/clock/useClockToasts.ts",
  "client/features/dice/throw/useThrows.ts",
  "client/features/dice/throw/hooks.ts",
  "client/features/view/store.ts",
  "client/features/weather/store.ts",
  "client/features/builder/WingPaneHost.tsx",
];

const PLACE = "place it in client/features/modules/surfaces.ts as drawn, probe, runtime or core";
const sites = (n: number) => `${n} control site${n === 1 ? "" : "s"}`;

describe("the control-site scan", () => {
  test("the scan reads the client's source", () => {
    assert.ok(scan.scanned.length > 300, `scanned ${scan.scanned.length} files`);
    assert.ok(scan.counts.size > 200, `${scan.counts.size} files hold a control site`);
  });

  test("every file with a control site is placed", () => {
    const listed = new Set(SURFACES.map((e) => e.file));
    const missing = [...scan.counts].filter(([file]) => !listed.has(file)).map(([file, n]) => `${file} holds ${sites(n)} and no entry: ${PLACE}`);
    assert.deepEqual(missing, []);
  });

  test("each entry records its file's control-site count", () => {
    const changed = SURFACES.filter((e) => (scan.counts.get(e.file) ?? 0) !== e.sites).map((e) => {
      const found = scan.counts.get(e.file) ?? 0;
      return `${e.file}: ${sites(e.sites)} listed, ${found} found. Place the entry again: check that its kind and covers still hold, then set sites to ${found}`;
    });
    assert.deepEqual(changed, []);
  });

  test("each entry names a file that exists, and one with a site unless it is a runtime gate", () => {
    const wrong = SURFACES.flatMap((e) => {
      if (!existsSync(path.join(REPO_ROOT, e.file))) return [`${e.file} does not exist: remove or rename its entry`];
      if (e.kind !== "runtime" && !scan.counts.has(e.file)) return [`${e.file} holds no control site: remove its ${e.kind} entry`];
      return [];
    });
    assert.deepEqual(wrong, []);
  });

  test("no file is listed twice", () => {
    const seen = new Set<string>();
    const twice = SURFACES.filter((e) => seen.size === seen.add(e.file).size).map((e) => `${e.file} is listed more than once`);
    assert.deepEqual(twice, []);
  });

  test("the primitives are the ones last placed", () => {
    const placed = new Set(PRIMITIVES);
    const found = new Set(scan.primitives);
    const added = scan.primitives.filter((p) => !placed.has(p)).map((p) => `new primitive ${p}: it renders a control, so each use of it is a control site. Place it on purpose: add it to PRIMITIVES and place again the files the scan now counts`);
    const gone = PRIMITIVES.filter((p) => !found.has(p)).map((p) => `gone primitive ${p}: remove it from PRIMITIVES`);
    assert.deepEqual([...added, ...gone], []);
  });

  test("covers name known parts", () => {
    const unknown = SURFACES.flatMap((e) => (e.kind === "core" ? [] : e.covers.filter((id) => !isModuleId(id)).map((id) => `${e.file} covers unknown part ${id}`)));
    assert.deepEqual(unknown, []);
  });

  test("every runtime gate of check 6 is a runtime entry with its test", () => {
    const wrong = RUNTIME_GATES.flatMap((file) => {
      const entry = SURFACES.find((e) => e.file === file);
      if (!entry) return [`${file} is a runtime gate with no entry`];
      if (entry.kind !== "runtime") return [`${file} is a runtime gate placed as ${entry.kind}`];
      if (entry.test.trim() === "" || entry.covers.length === 0) return [`${file} names no test or no part`];
      return [];
    });
    assert.deepEqual(wrong, []);
  });
});

describe("the scanner", () => {
  const files: Record<string, string> = {
    "client/lib/Menu.tsx": `export function Menu(props) { return <div>{props.items.map((it) => <div key={it.id} role={it.check ? "menuitemcheckbox" : "menuitem"} />)}</div>; }`,
    "client/lib/index.ts": `export { Menu } from "./Menu.tsx";`,
    "client/lib/Wrap.tsx": `import { Menu } from "./index.ts";\nexport const MenuOnly = () => <Menu items={[]} />;`,
    "client/lib/Outer.tsx": `import { MenuOnly as M } from "./Wrap.tsx";\nimport * as W from "./Wrap.tsx";\nexport default function Outer() { return <section><M /><W.MenuOnly /><Ctx.Provider /></section>; }`,
    "client/lib/Lazy.tsx": `const Late = lazy(() => import("./Outer.tsx"));\nexport function Host() { return <Late />; }`,
    "client/lib/Seeds.tsx": [
      `export function Plain() { return <span />; }`,
      `function row() { return <button />; }`,
      `export function UsesRow() { return <ul>{row()}</ul>; }`,
      `export function Seeds({ open, i }) {`,
      `  return (`,
      `    <>`,
      `      <input /><a href="x" /><a />`,
      `      <div role="group" /><div role={open ? "dialog" : "switch"} />`,
      `      <div tabIndex={0} /><div tabIndex={-1} /><div tabIndex={i === 0 ? -1 : undefined} />`,
      `      <p contentEditable /><p contentEditable={false} />`,
      `      <Plain />`,
      `    </>`,
      `  );`,
      `}`,
    ].join("\n"),
  };
  const fixture: Sources = { files: Object.keys(files).filter((f) => f.endsWith(".tsx")), read: (f) => files[f] };
  const result = scanControlSites(fixture);

  test("seeds: native controls, links with an href, interactive roles in any branch, a tab stop and an editable element", () => {
    const kinds = result.sites.filter((s) => s.file === "client/lib/Seeds.tsx").map((s) => `${s.tag} ${s.kind}`);
    assert.deepEqual(kinds, ["button native", "input native", "a link", "div role", "div tabIndex", "p contentEditable"]);
  });

  test("primitives to a fixed point: through a re-export, a renamed import, a namespace, a helper and a lazy loader", () => {
    assert.deepEqual(result.primitives, [
      "client/lib/Lazy.tsx#Host",
      "client/lib/Lazy.tsx#Late",
      "client/lib/Menu.tsx#Menu",
      "client/lib/Outer.tsx#Outer",
      "client/lib/Seeds.tsx#Seeds",
      "client/lib/Seeds.tsx#UsesRow",
      "client/lib/Wrap.tsx#MenuOnly",
    ]);
    assert.deepEqual(Object.fromEntries(result.counts), {
      "client/lib/Lazy.tsx": 1,
      "client/lib/Menu.tsx": 1,
      "client/lib/Outer.tsx": 2,
      "client/lib/Seeds.tsx": 6,
      "client/lib/Wrap.tsx": 1,
    });
    assert.deepEqual(
      result.unresolved.map((u) => `${u.tag} ${u.why}`),
      ["Ctx.Provider member"],
    );
  });
});
