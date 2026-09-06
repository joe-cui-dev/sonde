import type { WriteMode } from "../types.js";
import type { WriteStyle } from "./styles.js";

export interface WritePromptOptions { brief: string; draft?: string; mode: WriteMode; style: WriteStyle; language?: string; length?: number; }

export function writePrompt(options: WritePromptOptions): string {
  const length = options.length
    ? options.mode === "expand"
      ? `Aim for roughly ${options.length}× the draft's length; this is a soft target.`
      : `Aim for roughly ${options.length} words; this is a soft target.`
    : "Choose an appropriate length for the brief.";
  const language = options.language ? `Write in ${options.language}.` : "";
  const mode = options.mode === "new"
    ? "Write a complete, finished piece from the brief."
    : options.mode === "continue"
      ? "Return the entire draft followed by its continuation. Produce a complete, finished piece, never only the added continuation."
      : "Expand and rewrite the entire draft into a complete, finished piece. Return the whole rewritten piece, never only additions.";
  return [
    "You are Sonde's writing workflow. Produce prose only: no citations, source list, preamble, or discussion of your process.",
    mode, options.style.instructions, length, language,
    `Brief:\n${options.brief}`,
    options.draft ? `Draft:\n${options.draft}` : "",
  ].filter(Boolean).join("\n\n");
}
