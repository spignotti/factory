import { dirname } from "node:path";
import { sh } from "../exec.js";
import { type Jail, shellQuote } from "../sandbox/sandbox.js";

/**
 * GIF preview of a session video with the system ffmpeg: 8 fps, 640 px wide, palette pass.
 * Runs jailed when a jail is given (only the evidence dir writable). Returns an error text or undefined.
 */
export async function videoToGif(video: string, gif: string, opts: { env: Record<string, string>; jail?: Jail; fps?: number; width?: number }): Promise<string | undefined> {
  const fps = opts.fps ?? 8;
  const width = opts.width ?? 640;
  const filter = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`;
  const cmd = `ffmpeg -nostdin -hide_banner -loglevel error -y -i ${shellQuote(video)} -vf ${shellQuote(filter)} -loop 0 ${shellQuote(gif)}`;
  const dir = dirname(gif);
  const ro = dirname(video) === dir ? [] : [dirname(video)];
  const jail = opts.jail ? { ...opts.jail, rw: [dir], ro, ports: {} } : undefined;
  const r = await sh(cmd, { cwd: dir, env: opts.env, jail, timeoutMs: 120_000 });
  return r.code === 0 ? undefined : `ffmpeg exit ${r.code}: ${r.output.trim().split("\n").slice(-3).join(" | ")}`;
}
