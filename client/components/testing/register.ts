import { register } from "node:module";

/**
 * Import this first in a test that renders components: afterwards a
 * dynamic `import("./Button.tsx")` works under `node --test` (tsxHooks.ts).
 * A static import of a `.tsx` file would be resolved before this runs.
 */
register("./tsxHooks.ts", import.meta.url);
