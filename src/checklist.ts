/**
 * `.factory/checklist.md`: one item per Markdown list item. An item that a
 * deterministic check already enforces carries a marker `<!-- check: <check name> -->`; marked items
 * are skipped by the checklist reviewer and by `harden`. Continuation lines (indented, no bullet)
 * belong to the item above; headings, blank lines and other text are ignored.
 */
export interface ChecklistItem {
  /** 1-based line of the bullet. */
  line: number;
  text: string;
  /** Name from `<!-- check: name -->`; undefined = unmarked. */
  check?: string;
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const MARKER = /<!--\s*check:\s*([^\s>][^>]*?)\s*-->/;
const COMMENT = /<!--[\s\S]*?-->/g;

export function parseChecklist(text: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  let current: { line: number; raw: string } | undefined;
  const flush = () => {
    if (!current) return;
    const check = MARKER.exec(current.raw)?.[1];
    const clean = current.raw.replace(COMMENT, " ").replace(/\s+/g, " ").trim();
    if (clean) items.push({ line: current.line, text: clean, ...(check ? { check } : {}) });
    current = undefined;
  };
  text.split("\n").forEach((l, i) => {
    const m = BULLET.exec(l);
    if (m) {
      flush();
      current = { line: i + 1, raw: m[1]! };
    } else if (current && /^\s{2,}\S/.test(l)) {
      current.raw += ` ${l.trim()}`;
    } else {
      flush();
    }
  });
  flush();
  return items;
}

export const unmarkedItems = (items: ChecklistItem[]): ChecklistItem[] => items.filter((i) => !i.check);
