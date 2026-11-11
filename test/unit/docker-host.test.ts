import { describe, expect, it } from "vitest";
import { dockerHost } from "../../src/pipeline/context.js";

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
