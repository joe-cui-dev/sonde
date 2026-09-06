import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WriteMode } from "../types.js";

/**
 * Every writing run keeps its prose as a markdown file so the next run can be
 * pointed at it with `--in`. The default directory lives under `.sonde/`, which
 * is gitignored: these are working drafts, not repository content.
 */
export function archivePath(
  dir: string,
  mode: WriteMode,
  runId: string,
  at: Date = new Date(),
): string {
  // The timestamp leads so a directory listing sorts into chronological order,
  // which is how a draft gets found again. The run id, not the brief, names the
  // rest: it ties the file to its row in run history and keeps the name short
  // and predictable whatever was asked for.
  return join(dir, `${stamp(at)}-${mode}-${runId}.md`);
}

/**
 * Writes the prose and nothing else — no brief, no usage, no front matter.
 * Continue and expand read this file back as the draft, and anything that is
 * not the piece itself would be read as part of it.
 */
export function saveProse(path: string, prose: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, prose.endsWith("\n") ? prose : `${prose}\n`, "utf8");
}

/** Local time, not UTC: the listing is read by whoever ran the command. */
function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}
