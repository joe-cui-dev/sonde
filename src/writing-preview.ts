import type { PreviewOutput } from "./cli-preview.js";

/** Terminal-only, append-only view of prose that has already arrived. */
export class WritingPreviewRenderer {
  constructor(private readonly output: PreviewOutput) {}
  update(delta: string): void { if (this.output.isTTY === true) this.output.write(delta); }
  complete(): void { if (this.output.isTTY === true) this.output.write("\n\n[writing complete]\n"); }
  fail(reason: string): void { if (this.output.isTTY === true) this.output.write(`\n\n[writing incomplete: ${reason}]\n`); }
}
