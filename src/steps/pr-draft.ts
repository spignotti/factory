import type { GitHub } from "../gh.js";

/**
 * An open PR that is ready for review becomes a draft. Already-draft and closed PRs are unchanged.
 * `pr.draft` is the last status the factory stored; a live lookup wins when GitHub answers.
 */
export async function ensurePrDraft(github: GitHub, repoDir: string, pr: { url: string; draft: boolean }): Promise<{ draft: boolean; changed: boolean }> {
  const live = await github.prStatus(repoDir, pr.url).catch(() => null);
  if (live && live.state !== "open") return { draft: pr.draft, changed: false };
  const draft = live ? live.draft : pr.draft;
  if (draft) return { draft: true, changed: false };
  await github.markDraft(repoDir, pr.url);
  return { draft: true, changed: true };
}
