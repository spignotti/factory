import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PING = resolve(__dirname, "../../ops/box-heartbeat/ping.sh");
const SECRET = "https://hc-ping.example/secret-token-1234";

/** Temp HOME plus a fake `curl` on PATH that echoes its args (to both streams) and exits with $FAKE_CURL_RC. */
function sandbox(url?: string) {
  const home = mkdtempSync(join(tmpdir(), "hb-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const curl = join(bin, "curl");
  writeFileSync(curl, '#!/bin/sh\necho "$@"\necho "$@" >&2\nexit "${FAKE_CURL_RC:-0}"\n');
  chmodSync(curl, 0o755);
  if (url !== undefined) {
    mkdirSync(join(home, ".config/box-heartbeat"), { recursive: true });
    writeFileSync(join(home, ".config/box-heartbeat/ping-url"), url, { mode: 0o600 });
  }
  return (rc = 0) =>
    spawnSync("bash", [PING], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_CURL_RC: String(rc) },
    });
}

describe("box-heartbeat ping.sh", () => {
  it("fails with the path, not a URL, when the file is missing", () => {
    const r = sandbox()();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(".config/box-heartbeat/ping-url");
    expect(r.stdout + r.stderr).not.toMatch(/https?:/);
  });

  it("fails when the file is empty", () => {
    expect(sandbox("")().status).not.toBe(0);
  });

  it("pings without printing the URL", () => {
    const r = sandbox(`${SECRET}\n`)();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("secret-token");
  });

  it("reports only curl's exit code on failure", () => {
    const r = sandbox(SECRET)(22);
    expect(r.status).toBe(22);
    expect(r.stderr).toContain("curl exit 22");
    expect(r.stdout + r.stderr).not.toContain("secret-token");
  });
});
