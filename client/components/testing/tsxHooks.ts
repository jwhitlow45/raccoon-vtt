import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Module hooks that let a unit test import a `.tsx` component. Node strips
 * types from `.ts` by itself but has no JSX transform, so a component
 * test registers these first (see register.ts) and then imports the
 * component with a dynamic import. The transform is Vite's own (Oxc), the
 * one the dev server and the build use, so a test renders the code the
 * app ships.
 */

type Transform = (code: string, filename: string, options: { jsx: { runtime: "automatic" } }) => Promise<{ code: string }>;

let transform: Transform | null = null;

export async function load(
  url: string,
  context: unknown,
  nextLoad: (url: string, context: unknown) => Promise<{ format?: string; source?: unknown }>,
): Promise<{ format?: string; source?: unknown; shortCircuit?: boolean }> {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
  transform ??= ((await import("vite")) as unknown as { transformWithOxc: Transform }).transformWithOxc;
  const path = fileURLToPath(url);
  const { code } = await transform(await readFile(path, "utf8"), path, { jsx: { runtime: "automatic" } });
  return { format: "module", source: code, shortCircuit: true };
}
