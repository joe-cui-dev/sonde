import { createHash } from "node:crypto";
import { z } from "zod";
import { parseConfigJson, readConfigFile, renderZodIssues } from "./config-file.js";

/**
 * A person, not a personality knob: every field is prose the writer sees
 * verbatim, with nothing that would make Sonde reason about the story's own
 * timeline. Strict by design — a field silently accepted is a field a hostile
 * file could smuggle something in under.
 */
const CharacterCardInput = z
  .object({
    name: z.string().min(1),
    // Prompt content only: matching is by --character id, never by scanning
    // the brief or draft. Kept so a card can say how someone is addressed.
    aliases: z.array(z.string().min(1)).default([]),
    role: z.string().min(1).optional(),
    description: z.string().min(1),
    speech: z.string().min(1).optional(),
    relationships: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * Ids arrive through `--character`, so they must survive a shell — but ASCII-only
 * `\w` would force a Chinese or Japanese cast into unrecognizable ids. This
 * allows any script's letters and digits, still refusing whitespace and shell
 * metacharacters.
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
 * Unlike styles there is no built-in cast, so no file means no characters —
 * the ordinary case outside long-form narrative. A file that exists and is
 * wrong is still an error: silently dropping a malformed cast writes the scene
 * without the people it was supposed to describe, and the prose is paid for by
 * the time anyone notices. `maxBytes` is checked against the raw file, before
 * parsing an oversized one is worth doing.
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
 * A project's cast is whatever its file says, so there is no fixed list for
 * `--help`. A miss carries the catalogue it was looked up in, as `requireStyle` does.
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
 * An injected card is paid for on every call it rides along with, so an
 * uncapped field is an unbounded cost. Checked against the cards this run
 * selected, not the whole file: someone else's long backstory is not its problem.
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
 * A fingerprint of the file as it stood for this run, kept on `write_start` so
 * an audit can tell whether two runs' "aria" came from the same file. Sixteen
 * hex characters is a log line, not a content address.
 */
export function hashCharactersFile(path: string): string | undefined {
  const raw = readConfigFile(path, "characters");
  if (raw === null) return undefined;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
}

/**
 * The cards as the writer sees them, wrapped in markers the prompt can point
 * back to. This only draws the boundary; `CHARACTERS_ARE_REFERENCE` in
 * prompts.ts is what tells the model what it means.
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
