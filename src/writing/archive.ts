import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WriteMode } from "../types.js";

/**
* Every run keeps its prose as markdown so the next can be pointed at it with
* `--in`. Under the gitignored `.sonde/`: these are drafts, not repo content.
*/
export function archivePath(
  dir: string,
  mode: WriteMode,
  runId: string,
  at: Date = new Date(),
): string {
  // The timestamp leads so a listing sorts chronologically, which is how a draft
  // gets found again. The run id names the rest, tying the file to its row in run
  // history and keeping the name short whatever was asked for.
  return join(dir, `${stamp(at)}-${mode}-${runId}.md`);
}

/**
* The prose and nothing else — no brief, no usage, no front matter. Continue and
* expand read this back as the draft, and anything extra reads as part of it.
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
