import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { WriteMode } from "../types.js";

/**
 * One fixed writing run the eval repeats on every prompt change. No characters:
 * a cast lives in each user's gitignored file, and a case that depended on one
 * would measure that file rather than the prompt.
 */
export interface WritingCase {
  id: string;
  mode: WriteMode;
  brief: string;
  /** The draft's text, read from the file the case names. */
  draft?: string;
  draftPath?: string;
  style?: string;
  lang?: string;
  length?: number;
  /** Terms the prose must contain — see `checkMentions`. */
  mustMention: string[];
  note?: string;
}

const CaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  mode: z.enum(["new", "continue", "expand"]),
  brief: z.string().min(1),
  draft: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  lang: z.string().min(1).optional(),
  length: z.number().int().positive().optional(),
  mustMention: z.array(z.string().min(1)).default([]),
  note: z.string().optional(),
});

const CasesFileSchema = z.strictObject({ cases: z.array(CaseSchema).min(1) });

/**
 * Reads and checks the whole file before any case runs: a typo found halfway
 * through an eval is a typo found after paying for the first half.
 */
export function loadWritingCases(path: string): WritingCase[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`eval cases ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = CasesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`eval cases ${path}: ${issue.path.join(".") || "file"} — ${issue.message}`);
  }
  const seen = new Set<string>();
  return parsed.data.cases.map((entry) => {
    if (seen.has(entry.id)) throw new Error(`eval cases ${path}: duplicate id "${entry.id}"`);
    seen.add(entry.id);
    // The same rules `sonde write` enforces, so a case cannot ask for a run the CLI would refuse.
    if (entry.mode === "new" && entry.draft) throw new Error(`eval case ${entry.id}: new mode does not accept a draft`);
    if (entry.mode !== "new" && !entry.draft) throw new Error(`eval case ${entry.id}: ${entry.mode} mode needs a draft`);
    if (entry.mode === "new" && entry.style === "match") throw new Error(`eval case ${entry.id}: style match needs a draft`);
    const draftPath = entry.draft ? resolve(dirname(path), entry.draft) : undefined;
    let draft: string | undefined;
    if (draftPath) {
      try {
        draft = readFileSync(draftPath, "utf8");
      } catch {
        throw new Error(`eval case ${entry.id}: draft ${draftPath} could not be read`);
      }
    }
    return { ...entry, draft, draftPath };
  });
}
