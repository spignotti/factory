/** Path classes shared by reviewer activation, fast-lane escalation and the risk class. */

/** Dependency manifests and lockfiles, matched by name in any directory. */
export const DEPENDENCY_FILES = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", ".npmrc",
  "pyproject.toml", "uv.lock", "poetry.lock", "Pipfile", "Pipfile.lock", "setup.py", "setup.cfg", "requirements*.txt", "requirements*.in", "constraints*.txt",
  "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "Gemfile", "Gemfile.lock", "*.gemspec", "composer.json", "composer.lock",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.lockfile", "*.csproj", "packages.lock.json", "Directory.Packages.props",
  "mix.exs", "mix.lock", "Package.swift", "Package.resolved", "pubspec.yaml", "pubspec.lock", "deno.json", "deno.lock", "flake.nix", "flake.lock",
];
export const DEPENDENCY_GLOBS = DEPENDENCY_FILES.map((f) => `**/${f}`);

/**
 * Generated lockfiles (not manifests): left out of the diff line count, since no one reviews them line
 * by line. They still are dependency files (`DEPENDENCY_GLOBS`): lane escalation, risk and reviewers see them.
 */
export const LOCK_FILES = [
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "uv.lock", "poetry.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock",
  "gradle.lockfile", "packages.lock.json", "mix.lock", "Package.resolved", "pubspec.lock", "deno.lock", "flake.lock",
];
export const LOCK_GLOBS = LOCK_FILES.map((f) => `**/${f}`);
export const MIGRATION_GLOBS = ["**/migrations/**"];
