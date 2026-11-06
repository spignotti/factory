#!/usr/bin/env node
/* global process, URL */
/**
 * Builds a secret-free staging tarball of the already-compiled CLI and the eval assets.
 * Not a release: it does not touch the live install, tags, or the default profile.
 *
 *   pnpm build && node scripts/pack-staging.mjs
 *
 * Writes the directory and the gzip under FACTORY_STAGING_DIR (default /opt/cursor/artifacts).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const short = sha.slice(0, 12);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outDir = process.env.FACTORY_STAGING_DIR ?? "/opt/cursor/artifacts";
const name = `factory-staging-${short}`;
const stage = join(outDir, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const rel of pkg.files ?? []) cpSync(join(root, rel), join(stage, rel), { recursive: true });
const staged = { ...pkg, scripts: { ...pkg.scripts } };
// dist/ is already in the tarball. `prepare` would run tsc, which is not a production dependency.
delete staged.scripts.prepare;
writeFileSync(join(stage, "package.json"), JSON.stringify(staged, null, 2) + "\n");
cpSync(join(root, "pnpm-lock.yaml"), join(stage, "pnpm-lock.yaml"));
writeFileSync(
  join(stage, "BUILD.json"),
  JSON.stringify({ version: pkg.version, commit: sha, purpose: "staging, not a release" }, null, 2) + "\n",
);

const prefix = "/workspace/tmp/factory-staging";
const task = `${prefix}/evals/tasks/pallets__flask-5014.yaml`;
writeFileSync(
  join(stage, "STAGING.md"),
  `# Factory staging build

Not a release and not a production deploy. Version ${pkg.version}, commit ${sha}.

The live install (\`~/.factory\`, \`/home/box/.local/share/factory-releases\`) and the user profile stay unchanged. This tree does not contain Pi credentials, API keys, or a provider config.

## Install into an empty prefix

\`\`\`sh
mkdir -p ${prefix}
tar -xzf factory-staging-${short}.tar.gz -C /workspace/tmp
# the archive contains the directory factory-staging-${short}/
mv /workspace/tmp/factory-staging-${short} ${prefix}
cd ${prefix}
pnpm install --frozen-lockfile --prod --ignore-scripts
node dist/cli.js --version
# factory ${pkg.version} (${short})
\`\`\`

\`--ignore-scripts\` skips \`prepare\` (already removed from this package.json). Dependencies come from the lockfile; no git checkout and no source edit.

## Validate, then the repeated comparison

Use the packaged task file (same text as the release task; do not use a scratch copy). Profiles stay the operator's files. Work and results are fresh directories.

\`\`\`sh
cd /workspace/tmp/factory-modell-eval
node ${prefix}/dist/cli.js eval --validate \\
  --tasks ${task} \\
  --work-dir /workspace/tmp/factory-modell-eval/work-validate-101 \\
  --json

node ${prefix}/dist/cli.js eval \\
  --profile /workspace/tmp/factory-modell-eval/implement-high.yaml \\
  --profile /workspace/tmp/factory-modell-eval/implement-medium.yaml \\
  --tasks ${task} \\
  --repeat 2 \\
  --out /workspace/tmp/factory-modell-eval/results-101 \\
  --work-dir /workspace/tmp/factory-modell-eval/work-101
\`\`\`

Exit 0 and \`base red, fix green\` is a valid task. After the repeated run, \`hidden_status\` is \`pass\` or \`fail\` when pytest actually ran. \`hidden_status: harness\` (output starts with \`harness:\`) is an environment failure: exit 1, pass rate ignores those rows, and \`experiment\` prints no verdict. Do not read harness rows as model quality.

\`uv\` must be on \`PATH\`. CPython 3.11 does not need to be on \`PATH\`; \`uv venv -p 3.11\` installs it into the check environment.
`,
);

const tarPath = join(outDir, `${name}.tar.gz`);
rmSync(tarPath, { force: true });
execFileSync("tar", ["-czf", tarPath, "-C", outDir, name]);
const hash = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
writeFileSync(join(outDir, `${name}.tar.gz.sha256`), `${hash}  ${name}.tar.gz\n`);
process.stdout.write(`${tarPath}\n${hash}  ${name}.tar.gz\n`);
