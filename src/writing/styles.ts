import type { WriteStyleId } from "../types.js";

export interface WriteStyle { id: WriteStyleId; name: string; instructions: string; }

export const WRITE_STYLES: Record<WriteStyleId, WriteStyle> = {
  plain: { id: "plain", name: "Plain", instructions: "Write clearly and directly. Prefer concrete language and short sentences." },
  literary: { id: "literary", name: "Literary", instructions: "Use vivid, controlled imagery and careful rhythm without imitating any author." },
  reportage: { id: "reportage", name: "Reportage", instructions: "Use an observant, scene-led journalistic register without inventing reporting." },
  commentary: { id: "commentary", name: "Commentary", instructions: "Make a clear argument with an assured, thoughtful point of view." },
  explainer: { id: "explainer", name: "Explainer", instructions: "Explain ideas progressively, define terms, and make the logic easy to follow." },
  business: { id: "business", name: "Business", instructions: "Be concise, practical, and decision-oriented." },
};
