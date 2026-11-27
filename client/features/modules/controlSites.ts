import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";

/**
 * Finds every control site in the client's source (docs/design/design-v1-features.md 14,
 * check 5): each JSX element a person can press, type in, pick or focus,
 * and each use of a component that renders one. Discovery reads the source
 * and never the gates, so a control no gate knows about is still found
 * (D-261127-420).
 *
 * The seeds below are also the kinds the controls golden counts (check 3),
 * so the markup test can read them from here and the two never disagree.
 */

/** Native form controls, each a site wherever it is written. */
export const NATIVE_CONTROLS: readonly string[] = ["button", "input", "select", "textarea"];

/** A link is a site only with an `href`: a bare `<a>` takes no focus and does nothing. */
export const LINK = { tag: "a", attribute: "href" } as const;

/** Roles that make any element a control (D-261127-428). Landmark and live roles such as group, status and dialog are not here. */
export const INTERACTIVE_ROLES: readonly string[] = [
  "button",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "switch",
  "tab",
  "checkbox",
  "radio",
  "slider",
  "spinbutton",
  "textbox",
  "combobox",
  "link",
];

/** An element in the tab order is a site: `tabIndex={0}`, or an expression that can give 0. */
export const FOCUS_STOP = { attribute: "tabIndex", value: 0 } as const;

/** An editable element is a site unless the attribute is written false. */
export const EDITABLE = { attribute: "contentEditable" } as const;

export type SeedKind = "native" | "link" | "role" | "tabIndex" | "contentEditable";
export type SiteKind = SeedKind | "primitive";

export type ControlSite = { file: string; line: number; tag: string; kind: SiteKind; primitive?: string };

/** A capitalized tag the scan could not tie to a declaration, so its uses never count. */
export type Unresolved = { file: string; line: number; tag: string; why: "library" | "member" | "unknown" };

export type ControlScan = {
  /** Every file scanned, repo-relative, sorted. */
  scanned: readonly string[];
  /** The site count of each scanned file that has at least one. */
  counts: ReadonlyMap<string, number>;
  sites: readonly ControlSite[];
  /** `<file>#<name>` of every component that renders a site, sorted. */
  primitives: readonly string[];
  unresolved: readonly Unresolved[];
};

/* The ESTree nodes the scan reads. oxc gives every node `type`, `start` and `end`. */
type Node = { type: string; start: number; end: number; [key: string]: unknown };
/** A JSX attribute as oxc gives it: `value` is a literal, an expression container, or null for a bare attribute. */
export type JsxAttr = { type: string; name?: { type: string; name?: string }; value?: Node | null };

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** Keys that hold types or names, never a value a render could reach. */
const SKIPPED_KEYS = new Set(["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeArguments", "decorators"]);
const SKIPPED_TYPES = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSModuleDeclaration", "TSDeclareFunction", "ImportDeclaration"]);

function walk(node: Node, visit: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  if (SKIPPED_TYPES.has(node.type)) return;
  visit(node, parent);
  for (const key in node) {
    if (SKIPPED_KEYS.has(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (isNode(c)) walk(c, visit, node);
    } else if (isNode(child)) walk(child, visit, node);
  }
}

/** The values an expression can take, through conditionals, logical operators, parentheses and type assertions. */
function branches(expr: Node): Node[] {
  switch (expr.type) {
    case "ConditionalExpression":
      return [...branches(expr.consequent as Node), ...branches(expr.alternate as Node)];
    case "LogicalExpression":
      return [...branches(expr.left as Node), ...branches(expr.right as Node)];
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return branches(expr.expression as Node);
    default:
      return [expr];
  }
}

function attrValue(attr: JsxAttr): Node | null {
  const v = attr.value;
  if (!v) return null;
  return v.type === "JSXExpressionContainer" ? (v.expression as Node) : v;
}

function hasInteractiveRole(expr: Node): boolean {
  // Any role literal anywhere in the expression counts, not only its branches: a role picked from a call or a lookup still names a control, and a false find costs one entry.
  let found = false;
  walk(expr, (n) => {
    if (n.type === "Literal" && typeof n.value === "string" && INTERACTIVE_ROLES.includes(n.value)) found = true;
    if (n.type === "TemplateLiteral" && (n.expressions as unknown[]).length === 0) {
      const quasi = (n.quasis as { value: { cooked: string | null } }[])[0];
      if (quasi?.value.cooked && INTERACTIVE_ROLES.includes(quasi.value.cooked)) found = true;
    }
  });
  return found;
}

/** Whether a tabIndex can be 0. Only the branches are read, so `i === 0 ? 0 : -1` counts and `i === 0 ? -1 : undefined` does not. */
function canBeFocusStop(expr: Node): boolean {
  return branches(expr).some((b) => b.type === "Literal" && b.value === FOCUS_STOP.value);
}

function isFalse(expr: Node | null): boolean {
  if (!expr) return false;
  return branches(expr).every((b) => b.type === "Literal" && (b.value === false || b.value === "false"));
}

/** Which seed a JSX opening element is, if any. Native controls and links count as written tags only, the attribute seeds on any element. */
export function seedKind(tag: string, attributes: readonly JsxAttr[]): SeedKind | null {
  const intrinsic = /^[a-z]/.test(tag);
  if (intrinsic && NATIVE_CONTROLS.includes(tag)) return "native";
  const named = (name: string) => attributes.find((a) => a.type === "JSXAttribute" && a.name?.type === "JSXIdentifier" && a.name.name === name);
  if (intrinsic && tag === LINK.tag && named(LINK.attribute)) return "link";
  const role = named("role");
  const roleExpr = role ? attrValue(role) : null;
  if (roleExpr && hasInteractiveRole(roleExpr)) return "role";
  const tab = named(FOCUS_STOP.attribute);
  const tabExpr = tab ? attrValue(tab) : null;
  if (tabExpr && canBeFocusStop(tabExpr)) return "tabIndex";
  const editable = named(EDITABLE.attribute);
  if (editable && !isFalse(attrValue(editable))) return "contentEditable";
  return null;
}

/* What one file declares and imports, read once. */

type Ref = { file: string; name: string };
type Opening = { line: number; tag: string; seed: SeedKind | null; ref: Ref | null; unresolved: Unresolved["why"] | null };
type Decl = {
  name: string;
  openings: Opening[];
  /** Every identifier the declaration reads, resolved to another declaration where it can be. */
  reads: Ref[];
};
type FileInfo = {
  file: string;
  tsx: boolean;
  decls: Map<string, Decl>;
  /** Exported name to local declaration name. */
  exports: Map<string, string>;
  reexports: Map<string, Ref>;
  starFrom: string[];
  openings: Opening[];
};

const isComponentName = (name: string) => /^[A-Z]/.test(name);

function lineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function jsxTagName(name: Node): string {
  if (name.type === "JSXIdentifier") return name.name as string;
  if (name.type === "JSXMemberExpression") return `${jsxTagName(name.object as Node)}.${(name.property as { name: string }).name}`;
  if (name.type === "JSXNamespacedName") return `${(name.namespace as { name: string }).name}:${(name.name as { name: string }).name}`;
  return "?";
}

/** Names a top-level statement binds, each with the node that holds its value. */
function topLevelBindings(stmt: Node): { name: string; node: Node }[] {
  let target = stmt;
  if ((stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration") && isNode(stmt.declaration)) target = stmt.declaration;
  if ((target.type === "FunctionDeclaration" || target.type === "ClassDeclaration") && isNode(target.id)) return [{ name: target.id.name as string, node: target }];
  if (target.type === "VariableDeclaration") {
    const out: { name: string; node: Node }[] = [];
    for (const d of target.declarations as Node[]) {
      const names: string[] = [];
      walk(d.id as Node, (n, parent) => {
        // A destructured property's key is not a binding, its value is.
        if (n.type === "Identifier" && !(parent?.type === "Property" && parent.key === n && parent.computed !== true && parent.shorthand !== true)) names.push(n.name as string);
      });
      for (const name of names) out.push({ name, node: d });
    }
    return out;
  }
  return [];
}

/** `import("./x.tsx")` inside a lazy loader, with the export it picks from a `.then((m) => m.Name)`, or the default. */
function lazyTargets(node: Node): { source: string; name: string }[] {
  const sources: string[] = [];
  const picked: string[] = [];
  walk(node, (n) => {
    if (n.type === "ImportExpression" && isNode(n.source) && n.source.type === "Literal" && typeof n.source.value === "string") sources.push(n.source.value);
    if (n.type === "CallExpression" && isNode(n.callee) && n.callee.type === "MemberExpression" && (n.callee.property as { name?: string }).name === "then") {
      const fn = (n.arguments as Node[])[0];
      const param = fn && (fn.params as Node[] | undefined)?.[0];
      if (fn && param?.type === "Identifier") {
        walk(fn, (m) => {
          if (m.type === "MemberExpression" && m.computed !== true && isNode(m.object) && m.object.type === "Identifier" && m.object.name === param.name) picked.push((m.property as { name: string }).name);
        });
      }
    }
  });
  return sources.flatMap((source) => (picked.length > 0 ? picked : ["default"]).map((name) => ({ source, name })));
}

type Resolver = {
  /** A relative import's file, repo-relative, or null when it is a package or a file the scan cannot read. */
  resolveImport(from: string, spec: string): string | null;
};

type Imported = { file: string | null; name: string; bare: boolean };

function readFile(file: string, code: string, resolver: Resolver): FileInfo {
  const parsed = parseSync(file, code);
  if (parsed.errors.length > 0) throw new Error(`${file} does not parse: ${parsed.errors.map((e) => e.message).join("; ")}`);
  const program = parsed.program as unknown as Node;
  const starts = lineStarts(code);
  const info: FileInfo = { file, tsx: file.endsWith(".tsx"), decls: new Map(), exports: new Map(), reexports: new Map(), starFrom: [], openings: [] };
  const imports = new Map<string, Imported>();
  const body = program.body as Node[];

  for (const stmt of body) {
    if (stmt.type === "ImportDeclaration" && stmt.importKind !== "type") {
      const spec = (stmt.source as { value: string }).value;
      const target = resolver.resolveImport(file, spec);
      for (const s of stmt.specifiers as Node[]) {
        if (s.importKind === "type") continue;
        const local = (s.local as { name: string }).name;
        const name = s.type === "ImportDefaultSpecifier" ? "default" : s.type === "ImportNamespaceSpecifier" ? "*" : ((s.imported as { name?: string; value?: string }).name ?? (s.imported as { value: string }).value);
        imports.set(local, { file: target, name, bare: !spec.startsWith(".") });
      }
    }
    if (stmt.type === "ExportNamedDeclaration" && stmt.exportKind !== "type") {
      const from = isNode(stmt.source) ? resolver.resolveImport(file, (stmt.source as unknown as { value: string }).value) : null;
      for (const s of (stmt.specifiers as Node[]) ?? []) {
        if (s.exportKind === "type") continue;
        const local = (s.local as { name?: string; value?: string }).name ?? (s.local as { value: string }).value;
        const exported = (s.exported as { name?: string; value?: string }).name ?? (s.exported as { value: string }).value;
        if (isNode(stmt.source)) {
          if (from) info.reexports.set(exported, { file: from, name: local });
        } else info.exports.set(exported, local);
      }
      for (const b of isNode(stmt.declaration) ? topLevelBindings(stmt) : []) info.exports.set(b.name, b.name);
    }
    if (stmt.type === "ExportAllDeclaration" && stmt.exportKind !== "type" && stmt.exported == null) {
      const from = resolver.resolveImport(file, (stmt.source as { value: string }).value);
      if (from) info.starFrom.push(from);
    }
    if (stmt.type === "ExportDefaultDeclaration") {
      const d = stmt.declaration as Node;
      if ((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && isNode(d.id)) info.exports.set("default", d.id.name as string);
      else if (d.type === "Identifier") info.exports.set("default", d.name as string);
      else info.exports.set("default", "default");
    }
  }

  // Each top-level declaration renders the JSX it holds. An anonymous default export is named `default`.
  const pending = new Map<string, Node>();
  for (const stmt of body) {
    if (stmt.type === "ExportDefaultDeclaration") {
      const d = stmt.declaration as Node;
      if (!((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && isNode(d.id)) && d.type !== "Identifier") pending.set("default", d);
    }
    for (const b of topLevelBindings(stmt)) pending.set(b.name, b.node);
  }

  const resolveName = (name: string): { ref: Ref | null; why: Unresolved["why"] | null } => {
    if (pending.has(name)) return { ref: { file, name }, why: null };
    const imp = imports.get(name);
    if (imp) {
      if (imp.file) return { ref: { file: imp.file, name: imp.name }, why: null };
      return { ref: null, why: imp.bare ? "library" : "unknown" };
    }
    return { ref: null, why: "unknown" };
  };

  const read = (holder: Node): { openings: Opening[]; reads: Ref[] } => {
    const openings: Opening[] = [];
    const reads: Ref[] = [];
    let loads = false;
    walk(holder, (n, parent) => {
      if (n.type === "ImportExpression") loads = true;
      if (n.type === "JSXOpeningElement") {
        const nameNode = n.name as Node;
        const tag = jsxTagName(nameNode);
        const seed = seedKind(tag, n.attributes as JsxAttr[]);
        let ref: Ref | null = null;
        let why: Unresolved["why"] | null = null;
        if (nameNode.type === "JSXIdentifier" && isComponentName(tag)) ({ ref, why } = resolveName(tag));
        else if (nameNode.type === "JSXMemberExpression") {
          // `<NS.Name>` resolves when NS is a namespace import. A context's `.Provider` and the like stay unresolved.
          const object = nameNode.object as Node;
          const imp = object.type === "JSXIdentifier" ? imports.get(object.name as string) : undefined;
          const prop = (nameNode.property as { name: string }).name;
          if (imp?.name === "*" && imp.file) ref = { file: imp.file, name: prop };
          else why = "member";
        }
        openings.push({ line: lineAt(starts, n.start), tag, seed, ref, unresolved: seed ? null : why });
      }
      if (n.type === "Identifier") {
        // A property name or an object key is not a read of a binding.
        if (parent?.type === "MemberExpression" && parent.property === n && parent.computed !== true) return;
        if (parent?.type === "Property" && parent.key === n && parent.computed !== true && parent.shorthand !== true) return;
        const { ref } = resolveName(n.name as string);
        if (ref) reads.push(ref);
      }
    });
    for (const lazy of loads ? lazyTargets(holder) : []) {
      const target = resolver.resolveImport(file, lazy.source);
      if (target) reads.push({ file: target, name: lazy.name });
    }
    return { openings, reads };
  };

  // Names bound by one destructuring share its node, which is read and counted once.
  const readOnce = new Map<Node, { openings: Opening[]; reads: Ref[] }>();
  for (const [name, node] of pending) {
    let found = readOnce.get(node);
    if (!found) {
      found = read(node);
      readOnce.set(node, found);
      info.openings.push(...found.openings);
    }
    info.decls.set(name, { name, ...found });
  }
  // JSX outside every declaration (a top-level render call, say) still counts toward the file.
  for (const stmt of body) {
    if (stmt.type === "ImportDeclaration" || stmt.type === "ExportDefaultDeclaration" || topLevelBindings(stmt).length > 0) continue;
    info.openings.push(...read(stmt).openings);
  }
  return info;
}

export type Sources = {
  /** The files to scan, repo-relative with forward slashes. */
  files: readonly string[];
  /** A repo-relative file's text, or undefined when there is none. Also asked for .ts files an import reaches, for their re-exports. */
  read(file: string): string | undefined;
};

/** Scans the given sources to a fixed point of primitives (D-261127-426). */
export function scanControlSites(sources: Sources): ControlScan {
  const infos = new Map<string, FileInfo | null>();
  const exists = (file: string) => infos.has(file) || sources.read(file) !== undefined;
  const resolver: Resolver = {
    resolveImport(from, spec) {
      if (!spec.startsWith(".")) return null;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) if (/\.tsx?$/.test(candidate) && exists(candidate)) return candidate;
      return null;
    },
  };
  const infoOf = (file: string): FileInfo | null => {
    if (!infos.has(file)) {
      const code = sources.read(file);
      infos.set(file, code === undefined ? null : readFile(file, code, resolver));
    }
    return infos.get(file) ?? null;
  };

  const scanned = [...sources.files].sort();
  for (const file of scanned) infoOf(file);

  /** The declaration an exported name stands for, through re-exports and `export *`. */
  const declOf = (ref: Ref, seen = new Set<string>()): Ref | null => {
    const key = `${ref.file}#${ref.name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const info = infoOf(ref.file);
    if (!info) return null;
    const local = info.exports.get(ref.name);
    if (local !== undefined && info.decls.has(local)) return { file: ref.file, name: local };
    const re = info.reexports.get(ref.name);
    if (re) return declOf(re, seen);
    for (const from of info.starFrom) {
      const found = declOf({ file: from, name: ref.name }, seen);
      if (found) return found;
    }
    return null;
  };

  /** A local read is already a declaration of its own file. An imported one goes through the exports. */
  const resolved = new Map<string, Ref | null>();
  const target = (from: string, ref: Ref): Ref | null => {
    const cacheKey = `${from}>${ref.file}#${ref.name}`;
    if (!resolved.has(cacheKey)) {
      const info = infoOf(ref.file);
      resolved.set(cacheKey, ref.file === from && info?.decls.has(ref.name) ? ref : declOf(ref));
    }
    return resolved.get(cacheKey) ?? null;
  };

  // Every declaration in a .tsx file that renders a site, to a fixed point. Only .tsx can hold JSX, so a .ts file only passes names through.
  // Each declaration's reads resolve once, and a declaration found to render wakes only those that read it.
  const renders = new Set<string>();
  const readers = new Map<string, string[]>();
  const queue: string[] = [];
  for (const info of infos.values()) {
    if (!info?.tsx) continue;
    for (const decl of info.decls.values()) {
      const key = `${info.file}#${decl.name}`;
      if (decl.openings.some((o) => o.seed !== null)) queue.push(key);
      const deps = new Set<string>();
      for (const r of [...decl.openings.flatMap((o) => (o.ref ? [o.ref] : [])), ...decl.reads]) {
        const t = target(info.file, r);
        if (t) deps.add(keyOf(t));
      }
      for (const dep of deps) {
        const list = readers.get(dep) ?? [];
        list.push(key);
        readers.set(dep, list);
      }
    }
  }
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    if (renders.has(key)) continue;
    renders.add(key);
    for (const reader of readers.get(key) ?? []) if (!renders.has(reader)) queue.push(reader);
  }

  const sites: ControlSite[] = [];
  const counts = new Map<string, number>();
  const unresolved: Unresolved[] = [];
  for (const file of scanned) {
    const info = infoOf(file);
    if (!info) continue;
    const ordered = [...info.openings].sort((a, b) => a.line - b.line);
    for (const o of ordered) {
      const t = o.ref ? target(file, o.ref) : null;
      if (o.seed) sites.push({ file, line: o.line, tag: o.tag, kind: o.seed });
      else if (t && renders.has(keyOf(t))) sites.push({ file, line: o.line, tag: o.tag, kind: "primitive", primitive: keyOf(t) });
      else if (o.unresolved) unresolved.push({ file, line: o.line, tag: o.tag, why: o.unresolved });
    }
  }
  for (const s of sites) counts.set(s.file, (counts.get(s.file) ?? 0) + 1);

  // Only a capitalized name can be a JSX tag, so a helper that renders a site passes it on without being a primitive itself.
  const primitives = [...renders].filter((key) => {
    const name = key.slice(key.indexOf("#") + 1);
    return isComponentName(name) || name === "default";
  }).sort();
  return { scanned, counts, sites, primitives, unresolved };
}

const keyOf = (ref: Ref | null) => (ref ? `${ref.file}#${ref.name}` : "");

/** The repository's root, three folders up from this file. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every client .tsx that ships: tests are left out, as they draw fixtures and not the app. */
export function clientSources(root: string = REPO_ROOT): Sources {
  const files = readdirSync(path.join(root, "client"), { recursive: true, encoding: "utf8" })
    .map((f) => `client/${f.split(path.sep).join("/")}`)
    .filter((f) => f.endsWith(".tsx") && !/\.test\./.test(f) && !f.includes("/node_modules/"));
  const cache = new Map<string, string | undefined>();
  return {
    files,
    read(file) {
      if (!cache.has(file)) {
        let code: string | undefined;
        try {
          code = readFileSync(path.join(root, file), "utf8");
        } catch {
          code = undefined;
        }
        cache.set(file, code);
      }
      return cache.get(file);
    },
  };
}
