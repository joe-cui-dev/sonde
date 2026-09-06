import type { WriteMode } from "../types.js";
import type { WriteStyle } from "./styles.js";

export interface WritePromptOptions { brief: string; draft?: string; mode: WriteMode; style: WriteStyle; language?: string; length?: number; }

export function writePrompt(options: WritePromptOptions): string {
  return [
    "You are Sonde's writing workflow. Produce prose only: no citations, source list, preamble, or discussion of your process.",
    MODE_INSTRUCTIONS[options.mode],
    BRIEF_IS_BINDING,
    options.style.instructions,
    lengthInstruction(options.mode, options.length),
    options.language ? `Write in ${options.language}.` : "",
    `Brief:\n${options.brief}`,
    options.draft ? `Draft:\n${options.draft}` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * A brief is rarely one instruction. "Open up the storm, add the pedestrians
 * struggling along the road, start from the first thunderclap, 2000 words or
 * more" is four requirements, and a run that honours the first and forgets the
 * other three has failed even though it produced good prose. Naming them as a
 * checklist is what makes the difference between a hint and an obligation.
 */
const BRIEF_IS_BINDING =
  "Follow the brief to the letter. Read it as a list of requirements and satisfy every one: " +
  "what to write about, where to begin and end, what detail or material to include, what to leave out, how long to run. " +
  "The work is not finished while any requirement is unmet — check the brief again against what you have written before you stop. " +
  "Where the brief and these instructions disagree, the brief wins. " +
  "Do any planning silently: the output is the prose alone.";

const MODE_INSTRUCTIONS: Record<WriteMode, string> = {
  new: "Write a complete, finished piece from the brief.",
  continue:
    "Return the entire draft followed by its continuation. Produce a complete, finished piece, never only the added continuation.",
  // Expand is aimed, and its product is the passage, not the piece. Handing
  // back the whole draft with one part opened up buries the new writing in
  // prose the user already had, and invites the writer to quietly revise work
  // they were happy with. The draft is here as context; only the passage is
  // asked for.
  expand:
    "Expand one part of the draft, not the draft as a whole. " +
    "The brief names what to develop — a scene, a passage, a thread, a moment — and how to develop it: " +
    "where the expansion starts, what it must now contain that the draft only implies or omits, how far it runs. " +
    "Write that part alone, at length: more detail, more texture, more of what the draft was only gesturing at. " +
    "Return the new passage and nothing else. The draft is context, not output: do not reproduce it, do not summarize it, " +
    "do not lead in with what came before the passage or carry on past what came after it, " +
    "and do not head, label, frame, or introduce what you write. " +
    "What comes back has to read as finished prose that can be dropped straight into the draft in place of the part it develops.",
};

/**
 * Length always means the same thing in every mode — a count of the prose the
 * run is being asked to produce, which under expand is the passage and under
 * the other two is the whole piece.
 */
function lengthInstruction(mode: WriteMode, length?: number): string {
  if (!length) return "Choose an appropriate length for the brief.";
  const unit = "Count characters rather than words when writing in Chinese, Japanese, or Korean.";
  const briefWins = "If the brief states its own length, that figure governs instead.";
  return mode === "expand"
    ? `The passage must run to at least ${length} words. ` +
        "Do not stop short of it: if it is running out before the count is met, " +
        "develop the material further — more of the scene, moment by moment — rather than summarizing, " +
        `skipping ahead, or winding up early. ${unit} ${briefWins}`
    : `Aim for roughly ${length} words; this is a soft target. ${unit} ${briefWins}`;
}
