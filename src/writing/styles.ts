import type { BuiltInStyleId, WriteMode, WriteStyleId } from "../types.js";

/**
 * A style is a specification, not an adjective. "Vivid" and "concise" reach the
 * writer as whatever those words average out to across everything ever written,
 * which is the most worn version of each — the stock simile, the clipped
 * sentence with nothing in it. What does constrain a sentence is a move the
 * writer can perform and a failure it can be told to steer around, so every
 * style names both.
 */
export interface WriteStyle {
  id: WriteStyleId;
  name: string;
  /** One line: what this register is for. */
  summary: string;
  /** Sentence-level moves, concrete enough to check the prose against. */
  moves: string[];
  /** The failure this register falls into, named so it can be avoided. */
  avoid: string[];
}

export const WRITE_STYLES: Record<BuiltInStyleId, WriteStyle> = {
  // The one style with no register of its own. It is the right default for a
  // run that writes into prose someone else already wrote.
  match: {
    id: "match",
    name: "Match the draft",
    summary:
      "Take the register from the draft itself rather than bringing one.",
    moves: [
      "Read the draft for its sentence lengths, its diction, its tense and person, " +
        "its paragraph rhythm, and how much it shows against how much it tells.",
      // Register is only half of what a seam gives away. A draft that moves
      // moment by moment and new prose that covers ground read as two writers
      // even when every sentence is pitched alike, and this style is the
      // default on the two modes that write into someone else's prose.
      "Match the draft's granularity as well as its register: how much time passes in a paragraph, " +
        "how much of an action gets shown. If the draft moves moment by moment, keep moving moment by moment.",
      "Write so that the seam does not show: a reader should not be able to say " +
        "where the draft stops and the new prose starts.",
      "Where the draft is uneven, follow its strongest passages rather than its weakest.",
    ],
    avoid: [
      "Any shift of register, tense, person, or formality the brief did not ask for.",
      "Narrating at a coarser grain than the draft — covering in one sentence what the draft would have given a paragraph.",
      "Tidying, modernizing, or smoothing the draft's habits into your own.",
    ],
  },

  plain: {
    id: "plain",
    name: "Plain",
    summary:
      "Clear and direct: the sentence gives up its meaning on one reading.",
    moves: [
      "Put the actor before the action — name who did what, in that order.",
      "Prefer the concrete noun to the category it belongs to.",
      "Split any sentence that needs a second reading into two that do not.",
      "State the point, then support it.",
    ],
    avoid: [
      'Abstract nouns doing a verb\'s work — "the implementation of" where "we implemented" would do.',
      "Hedges and intensifiers that survive their own deletion.",
      "Sentences whose subject is a process rather than a person or a thing.",
    ],
  },

  literary: {
    id: "literary",
    name: "Literary",
    summary:
      "Controlled imagery and deliberate rhythm; the meaning carried by detail.",
    moves: [
      "Vary sentence length on purpose: let a long sentence built of clauses be answered by a short one.",
      "Carry feeling through physical detail and action, never through a word that names the feeling.",
      "Draw every figure of speech from the material of the scene itself.",
      "Stay inside one consciousness per passage, and let what gets noticed characterize whoever is noticing.",
    ],
    avoid: [
      "Simile as decoration — an image that could be lifted into another scene unchanged.",
      "Closing a paragraph on a summarizing flourish.",
      "Abstract nouns as subjects where a person or a thing could act instead.",
    ],
  },

  reportage: {
    id: "reportage",
    name: "Reportage",
    summary:
      "Observed, scene-led journalism: what was seen, said, and counted.",
    moves: [
      "Open in a place, at a time, with something happening.",
      "Report what was seen, said, and counted; attribute anything that was not.",
      "Let the detail carry the judgment instead of stating the judgment.",
      "Stay out of the frame unless your presence changed what happened.",
    ],
    avoid: [
      "Inventing quotes, sources, figures, or events — write only what the brief and the draft supply.",
      "Summarizing a scene you could show.",
      "Editorial adjectives standing in for reported detail.",
    ],
  },

  commentary: {
    id: "commentary",
    name: "Commentary",
    summary: "An argument with a point of view, assured and earned.",
    moves: [
      "Say what you think in the first paragraph, then spend the piece earning it.",
      "Put the strongest version of the opposing case on the page before you answer it.",
      "Anchor every turn of the argument in a specific case, figure, or consequence.",
      "Keep the sentences assured — qualification belongs inside the claim, not in a hedge around it.",
    ],
    avoid: [
      "Ending on a call for balance or further conversation you did not argue for.",
      "Rhetorical questions standing in for claims.",
      "A weakened version of the position you are arguing against.",
    ],
  },

  explainer: {
    id: "explainer",
    name: "Explainer",
    summary:
      "Ideas built in an order that leaves the reader nothing to take on faith.",
    moves: [
      "Order the ideas so that nothing depends on something the reader has not met yet.",
      "Define a term the first time it appears, in the sentence that uses it.",
      "Follow each mechanism with what it costs, or where it stops working.",
      "Use one analogy where it does real work, and drop it before it breaks.",
    ],
    avoid: [
      "Calling a thing simple, easy, or intuitive.",
      "Stacking analogies on the same idea.",
      "Numbered scaffolding where the prose could carry the order on its own.",
    ],
  },

  business: {
    id: "business",
    name: "Business",
    summary:
      "Concise and decision-oriented: what to do, and why, in that order.",
    moves: [
      "Lead with the recommendation or the finding; put the reasoning underneath it.",
      "Quantify wherever a figure exists, and say plainly where one does not.",
      "Name the decision being asked for and who has to make it.",
      "Give the option you did not take, and the reason you did not take it.",
    ],
    avoid: [
      "Throat-clearing before the point.",
      "Describing status where a recommendation was wanted.",
      "Abstractions — alignment, leverage, synergies — standing in for the thing itself.",
    ],
  },
};

/**
 * The style as it reaches the writer: a heading, the moves, the failures. A
 * style from a styles file may name no failures at all, and a bare "Avoid:"
 * with nothing under it would read as an instruction that got lost.
 */
export function renderStyle(style: WriteStyle): string {
  return [
    `Style — ${style.name}: ${style.summary}`,
    ["Do this:", ...style.moves.map((move) => `- ${move}`)].join("\n"),
    style.avoid.length
      ? ["Avoid:", ...style.avoid.map((failure) => `- ${failure}`)].join("\n")
      : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * A continue or expand run writes into prose that already has a register, and
 * one chosen for it would show at exactly the seam it is meant to hide, so
 * those two modes default to taking the register from the draft.
 *
 * New writing has no draft to take a register from, and rather than pick one
 * on the writer's behalf it gets none: an unasked-for register is a constraint
 * nobody wrote into the brief, and a brief that wants one can say so in its own
 * words. With no style the prompt carries no style section at all — see
 * `writePrompt`.
 */
export function defaultStyle(mode: WriteMode): BuiltInStyleId | undefined {
  return mode === "new" ? undefined : "match";
}
