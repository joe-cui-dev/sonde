import { z } from "zod";
import type { WriteStyleId } from "../types.js";
import { parseConfigJson, readConfigFile, renderZodIssues } from "./config-file.js";
import { WRITE_STYLES, type WriteStyle } from "./styles.js";

/**
* The styles shipped with Sonde are guesses at which registers people write in;
* a styles file is where the rest go. It lives under the gitignored .sonde/,
* because a register is the writer's own.
*/
const CustomStyle = z
  .object({
    name: z.string().min(1).optional(),
    summary: z.string().min(1, "must say in one line what the register is for"),
    // Moves are what separate a specification from an adjective.
    moves: z
      .array(z.string().min(1))
      .min(1, "must list at least one move — a style with none is just an adjective"),
    avoid: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** Ids arrive through `--style`, so they must survive a shell and read as one word. */
const StyleFile = z.record(
  z.string().regex(/^[\w-]+$/u, "must be letters, digits, hyphens, or underscores"),
  CustomStyle,
);

export type StyleCatalogue = Record<WriteStyleId, WriteStyle>;

/**
* The built-ins with the file laid over them: an entry named for a built-in
* replaces it outright rather than merging, so the writer always receives
* exactly one spec. An absent file is the ordinary case; one that exists and is
* wrong is an error, since falling back would write the piece in a register
* nobody chose and the prose is paid for by then.
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
* Once a styles file can add styles there is no fixed list for `--help`, so the
* miss carries the catalogue it was looked up in.
*/
export function requireStyle(catalogue: StyleCatalogue, id: WriteStyleId): WriteStyle {
  const style = catalogue[id];
  if (style) return style;
  throw new Error(`Unknown style: ${id}. Available: ${Object.keys(catalogue).sort().join(", ")}`);
}
