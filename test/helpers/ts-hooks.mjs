// Resolve hook for child processes in tests: `./x.js` imports inside src/ map to `./x.ts` (Node strips types).
import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("file:")) && context.parentURL) {
    const ts = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
}
