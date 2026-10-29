// Writes schemas/*.schema.json from the zod contracts in dist (`pnpm schemas` builds first).
/* global process */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSON_SCHEMAS, renderJsonSchema } from "../dist/schemas/json.js";

const dir = join(import.meta.dirname, "..", "schemas");
mkdirSync(dir, { recursive: true });
for (const name of Object.keys(JSON_SCHEMAS)) writeFileSync(join(dir, name), renderJsonSchema(name));
process.stdout.write(`wrote ${Object.keys(JSON_SCHEMAS).length} schemas to schemas/` + "\n");
