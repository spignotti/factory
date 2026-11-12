/**
 * Whether the review already on `reviewedSha` still covers `head`.
 * An unchanged clean tree is not reviewed again. An open bug on that same commit still blocks.
 * A different tree is reviewed as a delta.
 */
export function reviewCoversHead(reviewedSha: string | undefined, head: string, openBugs: number): "review" | "skip_clean" | "block_bug" {
  if (!reviewedSha || reviewedSha !== head) return "review";
  return openBugs > 0 ? "block_bug" : "skip_clean";
}

/**
 * A moved tree invalidates review of the files that moved. Findings on untouched files stay as they are.
 * A finding with no file is about the whole change, so a non-empty delta reopens it.
 */
export function invalidateAffected<T extends { file: string; status: string }>(findings: T[], delta: readonly string[]): T[] {
  if (!delta.length) return findings;
  const touched = new Set(delta);
  return findings.map((f) => {
    if (f.status === "open") return f;
    if (f.file && !touched.has(f.file)) return f;
    return { ...f, status: "open" };
  });
}
