import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { agentEnv, commandEnv, dockerHost } from "../../src/pipeline/context.js";
import { parseRepoConfig, type RepoConfig } from "../../src/schemas/repo.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { FIXTURES } from "../helpers/repo.js";

describe("docker socket for checks", () => {
  it("keeps an explicit DOCKER_HOST", () => {
    expect(dockerHost({ DOCKER_HOST: "tcp://h:2375" }, "/home/u", () => true)).toBe("tcp://h:2375");
  });
  it("uses Docker Desktop's per-user socket when there is no default socket", () => {
    const seen = (p: string) => p === "/Users/u/.docker/run/docker.sock";
    expect(dockerHost({}, "/Users/u", seen)).toBe("unix:///Users/u/.docker/run/docker.sock");
  });
  it("adds nothing when the default socket exists or no socket is found", () => {
    expect(dockerHost({}, "/home/u", (p) => p === "/var/run/docker.sock")).toBeUndefined();
    expect(dockerHost({}, "/home/u", () => false)).toBeUndefined();
  });
});

describe("docker host in the agent env", () => {
  const profile = loadProfile(join(FIXTURES, "profile.yaml"));
  const repo = parseRepoConfig("agent_env: []\nsecrets: { provider: env_file, names: [DB_PASSWORD] }") as RepoConfig;
  const secrets = { env: { DB_PASSWORD: "s3cret" }, missing: [], redact: [], short: [], files: [], names: ["DB_PASSWORD"] };
  const mk = (parentEnv: Record<string, string>, fs?: "bwrap" | "none") =>
    ({ deps: { profile, parentEnv, factoryHome: "/f", ...(fs ? { sandbox: { mode: "preferred", fs, net: "isolated", warnings: [] } } : {}) } as never, repo, agentHome: "/h", secrets });
  const host = "unix:///Users/u/.docker/run/docker.sock";

  it("agents get the host the checks use, and still no repo secrets", () => {
    const ctx = mk({ PATH: "/bin", DOCKER_HOST: host });
    expect(agentEnv(ctx, "implement").DOCKER_HOST).toBe(host);
    expect(commandEnv(ctx).DOCKER_HOST).toBe(host);
    expect(agentEnv(ctx, "implement").DB_PASSWORD).toBeUndefined();
  });
  it("a jailed agent gets no docker host (the jail never binds the socket); host commands still do", () => {
    const ctx = mk({ PATH: "/bin", DOCKER_HOST: host }, "bwrap");
    expect(agentEnv(ctx, "implement").DOCKER_HOST).toBeUndefined();
    expect(commandEnv(ctx).DOCKER_HOST).toBe(host);
  });
  it("an unjailed run (sandbox degraded to none) keeps it", () => {
    expect(agentEnv(mk({ PATH: "/bin", DOCKER_HOST: host }, "none"), "implement").DOCKER_HOST).toBe(host);
  });
});
