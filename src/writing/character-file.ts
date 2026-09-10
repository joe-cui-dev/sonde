import { createHash } from "node:crypto";
import { z } from "zod";
import { parseConfigJson, readConfigFile, renderZodIssues } from "./config-file.js";

/**
 * A person, not a personality knob. Every field here is prose the writer will
 * see verbatim — there is no `visibility`, no `effectiveFrom`, nothing that
 * would need Sonde to reason about the story's own timeline. That is a
 * deliberate first-version boundary, not an oversight: a field this schema
 * does not know about is rejected rather than passed through, because a
 * field it silently accepted would be a field a hostile file could use to
 * smuggle something else in under a name of its choosing.
 */
const CharacterCardInput = z
  .object({
    name: z.string().min(1),
    // Prompt content only in this version — matching is by --character id,
    // never by scanning the brief or draft for a name. Kept here anyway so a
    // card can say how a character is addressed without repeating it in the
    // description.
    aliases: z.array(z.string().min(1)).default([]),
    role: z.string().min(1).optional(),
    description: z.string().min(1),
    speech: z.string().min(1).optional(),
    relationships: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * Ids reach the writer through `--character`, so a Latin name has to survive
 * a shell the same way a style id does — but a cast built around a Chinese or
 * Japanese story would otherwise be forced into ids nobody would recognize.
 * `\w` is ASCII-only; this widens it to any letter or digit in any script
 * while still refusing whitespace, shell metacharacters, and punctuation.
 */
const CharacterFile = z.record(
  z.string().regex(/^[\p{L}\p{N}_-]+$/u, "must be letters, digits, hyphens, or underscores"),
  CharacterCardInput,
);

export interface CharacterCard {
  id: string;
  name: string;
  aliases: string[];
  role?: string;
  description: string;
  speech?: string;
  relationships: string[];
}

export type CharacterCatalogue = Record<string, CharacterCard>;

/**
 * Unlike styles, there is no built-in cast to fall back to — a project with
 * no characters file simply has no characters to inject, and that is the
 * ordinary case for anyone using `sonde write` outside long-form narrative.
 * A file that exists and is wrong is still an error: a run that silently
 * dropped a malformed cast would write the scene without whoever the file
 * was supposed to describe, and the prose is paid for by the time anyone
 * notices they are missing.
 *
 * `maxBytes` is checked here, against the raw file, before it is even parsed
 * — a JSON parse of an oversized file is itself work worth skipping, and the
 * failure reads the same way a torn-up JSON file would: named, not truncated.
 */
export function loadCharacters(path: string, maxBytes = Infinity): CharacterCatalogue {
  const raw = readConfigFile(path, "characters");
  if (raw === null) return {};
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `Characters file ${path} is ${bytes.toLocaleString()} bytes, over the ${maxBytes.toLocaleString()}-byte limit ` +
        "(SONDE_MAX_CHARACTERS_FILE_BYTES) — split it or raise the limit.",
    );
  }
  const parsed = CharacterFile.safeParse(parseConfigJson(raw, path, "characters"));
  if (!parsed.success) {
    throw new Error(`Invalid characters file ${path}:\n${renderZodIssues(parsed.error.issues)}`);
  }
  const catalogue: CharacterCatalogue = {};
  for (const [id, card] of Object.entries(parsed.data)) {
    catalogue[id] = { id, ...card };
  }
  return catalogue;
}

/**
 * Named characters are only usable if they can be found, and a project's
 * cast is whatever its characters file says it is — there is no fixed list
 * to print in `--help` the way there is for the six built-in styles. So a
 * miss carries the catalogue it was looked up in, the same way `requireStyle`
 * does.
 */
export function requireCharacter(catalogue: CharacterCatalogue, id: string): CharacterCard {
  const card = catalogue[id];
  if (card) return card;
  const available = Object.keys(catalogue).sort().join(", ");
  throw new Error(
    `Unknown character: ${id}. Available: ${available || "(none — no characters file, or it defines no one by this name)"}`,
  );
}

/**
 * A card injected into a run is paid for on every call it rides along with,
 * so a field with no ceiling is an unbounded cost carrying someone else's
 * name. Checked against the cards actually selected for this run, not the
 * whole file — a cast file may hold far more people than one scene needs,
 * and someone else's over-long backstory should not stop this run.
 */
export function assertFieldLimit(card: CharacterCard, maxChars: number): void {
  const scalar: Array<[string, string | undefined]> = [
    ["name", card.name],
    ["role", card.role],
    ["description", card.description],
    ["speech", card.speech],
  ];
  for (const [field, value] of scalar) {
    if (value !== undefined && value.length > maxChars) {
      throw new Error(
        `Character "${card.id}" field "${field}" is ${value.length.toLocaleString()} characters, ` +
          `over the ${maxChars.toLocaleString()}-character limit (SONDE_MAX_CHARACTER_FIELD_CHARS).`,
      );
    }
  }
  const lists: Array<[string, string[]]> = [
    ["aliases", card.aliases],
    ["relationships", card.relationships],
  ];
  for (const [field, values] of lists) {
    for (const value of values) {
      if (value.length > maxChars) {
        throw new Error(
          `Character "${card.id}" field "${field}" has an entry of ${value.length.toLocaleString()} characters, ` +
            `over the ${maxChars.toLocaleString()}-character limit (SONDE_MAX_CHARACTER_FIELD_CHARS).`,
        );
      }
    }
  }
}

/**
 * A short fingerprint of the characters file as it stood for this run, kept
 * on the `write_start` event so a later audit can tell whether "aria" in two
 * different runs' logs came from the same file without diffing the whole
 * thing. Sixteen hex characters of SHA-256 is plenty to tell "changed" from
 * "unchanged" — this is a fingerprint for a log line, not a content address.
 */
export function hashCharactersFile(path: string): string | undefined {
  const raw = readConfigFile(path, "characters");
  if (raw === null) return undefined;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
}

/**
 * The cards as the writer will actually see them, wrapped in markers plain
 * enough to point back to from the surrounding prompt text (see
 * `CHARACTERS_ARE_REFERENCE` in prompts.ts, which is what actually tells the
 * model these markers bound data with no authority over it — this function
 * only draws the boundary, it does not explain what the boundary means).
 */
export function renderCharacters(cards: CharacterCard[]): string {
  return [
    "--- character reference ---",
    cards.map(renderCard).join("\n\n"),
    "--- end character reference ---",
  ].join("\n\n");
}

function renderCard(card: CharacterCard): string {
  const lines = [card.aliases.length ? `${card.name} (also: ${card.aliases.join(", ")})` : card.name];
  if (card.role) lines.push(`Role: ${card.role}`);
  lines.push(card.description);
  if (card.speech) lines.push(`Speech: ${card.speech}`);
  if (card.relationships.length) lines.push(`Relationships: ${card.relationships.join("; ")}`);
  return lines.join("\n");
}
