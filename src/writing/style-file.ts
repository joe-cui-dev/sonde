import { z } from "zod";
import type { WriteStyleId } from "../types.js";
import { parseConfigJson, readConfigFile, renderZodIssues } from "./config-file.js";
import { WRITE_STYLES, type WriteStyle } from "./styles.js";

/**
 * A style is a register somebody writes in, and the six that ship with Sonde
 * are guesses about which registers that will be. A styles file is where the
 * rest go: it lives outside the repo, under the gitignored .sonde/, because a
 * register is the writer's own and has no business in anyone else's history.
 */
const CustomStyle = z
  .object({
    name: z.string().min(1).optional(),
    summary: z.string().min(1, "must say in one line what the register is for"),
    // Moves are what separates a specification from an adjective, so a style
    // with none of them is the thing this whole design exists to avoid.
    moves: z
      .array(z.string().min(1))
      .min(1, "must list at least one move — a style with none is just an adjective"),
    avoid: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * Ids reach the writer through `--style`, so they have to survive a shell and
 * read as one word.
 */
const StyleFile = z.record(
  z.string().regex(/^[\w-]+$/u, "must be letters, digits, hyphens, or underscores"),
  CustomStyle,
);

export type StyleCatalogue = Record<WriteStyleId, WriteStyle>;

/**
 * The built-in styles with the file's laid over them: a file entry named for a
 * built-in replaces it outright rather than merging into it, so what the writer
 * receives is always exactly one style spec and the file is the whole of it.
 *
 * An absent file is the ordinary case and means the built-ins alone. A file
 * that exists and is wrong is an error: a run that quietly fell back to a
 * built-in would write the piece in a register nobody chose, and the prose is
 * paid for by then.
 */
export function loadStyles(path: string): StyleCatalogue {
  const raw = readConfigFile(path, "styles");
  if (raw === null) return { ...WRITE_STYLES };
  const parsed = StyleFile.safeParse(parseConfigJson(raw, path, "styles"));
  if (!parsed.success) {
    throw new Error(`Invalid styles file ${path}:\n${renderZodIssues(parsed.error.issues)}`);
  }
  const catalogue: StyleCatalogue = { ...WRITE_STYLES };
  for (const [id, style] of Object.entries(parsed.data)) {
    catalogue[id] = { id, name: style.name ?? id, summary: style.summary, moves: style.moves, avoid: style.avoid };
  }
  return catalogue;
}

/**
 * Named styles are only usable if they can be found, and once a styles file can
 * add them there is no fixed list to print in `--help`. So the miss carries the
 * catalogue it was looked up in.
 */
export function requireStyle(catalogue: StyleCatalogue, id: WriteStyleId): WriteStyle {
  const style = catalogue[id];
  if (style) return style;
  throw new Error(`Unknown style: ${id}. Available: ${Object.keys(catalogue).sort().join(", ")}`);
}
