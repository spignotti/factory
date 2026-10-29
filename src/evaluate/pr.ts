import type { EvaluateReport } from "../steps/evaluate.js";

/** Link of an evidence file in the PR, or undefined when it was not published. */
export type EvidenceLink = (file: string) => string | undefined;

const isImage = (file: string) => /\.(png|gif)$/.test(file);

function ref(file: string, label: string, link: EvidenceLink): string {
  const url = link(file);
  return url ? `[${label}](${url})` : `\`${file}\``;
}

/** The acceptance table's evidence cell of an evaluator criterion. */
export function criterionEvidence(report: EvaluateReport | undefined, id: string, link: EvidenceLink): { met: boolean; cell: string } | undefined {
  const c = report?.criteria.find((x) => x.id === id);
  if (!c) return undefined;
  const verdict = c.met ? "evaluator: met" : "evaluator: NOT met";
  return { met: c.met, cell: c.screenshot ? `${verdict}, ${ref(c.screenshot, "screenshot", link)}` : verdict };
}

/** The PR's evaluation section (§6.9.3): flows, pages with diffs, session GIF, screenshots. */
export function evaluationMarkdown(report: EvaluateReport | undefined, link: EvidenceLink, notes: string[] = []): string {
  if (!report) return "";
  const lines = [`## Evaluation (round ${report.round})`, ""];
  lines.push(`Devices: ${report.devices.join(", ")}${report.areas.length ? ` · areas: ${report.areas.join(", ")}` : ""}`, "");
  if (report.flows.length) lines.push(...report.flows.map((f) => `- flow ${f.area}: ${f.status}${f.status === "fail" ? (f.changes_flows ? " (planned flow change)" : " (regression)") : ""}`));
  for (const p of report.pages) {
    const errors = p.new_console.length + p.new_network.length;
    const parts = [p.head ? ref(p.head, "HEAD", link) : "no screenshot"];
    if (p.base) parts.push(ref(p.base, "base", link));
    if (p.diff) parts.push(`${ref(p.diff, "diff", link)} ${((p.diff_ratio ?? 0) * 100).toFixed(1)}% changed`);
    else if (p.base) parts.push("no pixel change");
    lines.push(`- page ${p.page} (${p.device}): ${parts.join(" · ")}${errors ? ` · ${errors} new console/network error(s)` : ""}`);
  }
  const gif = report.evidence.find((e) => e.kind === "gif");
  const gifUrl = gif && link(gif.file);
  if (gifUrl) lines.push("", `![evaluator session](${gifUrl})`);
  const video = report.evidence.find((e) => e.kind === "video");
  if (video) lines.push("", `Video: ${ref(video.file, video.file, link)}`);
  const shots = report.criteria.filter((c) => c.screenshot && isImage(c.screenshot));
  if (shots.length) {
    lines.push("", "| Criterion | Screenshot |", "|---|---|");
    for (const c of shots) {
      const url = link(c.screenshot!);
      lines.push(`| ${c.id} ${c.met ? "✅" : "❌"} | ${url ? `<img src="${url}" width="320">` : `\`${c.screenshot}\``} |`);
    }
  }
  const all = [...report.notes, ...notes];
  if (all.length) lines.push("", ...all.map((n) => `> ${n}`));
  return lines.join("\n") + "\n";
}
