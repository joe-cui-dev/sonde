import type { PreviewOutput } from "./cli-preview.js";

/** Terminal-only, append-only view of prose that has already arrived. */
export class WritingPreviewRenderer {
  private wrote = false;
  constructor(private readonly output: PreviewOutput) {}
  /** Whether any prose has actually reached the terminal through this renderer. */
  get streamed(): boolean { return this.wrote; }
  update(delta: string): void {
    if (this.output.isTTY !== true || delta === "") return;
    this.output.write(delta);
    this.wrote = true;
  }
  complete(): void { if (this.output.isTTY === true) this.output.write("\n\n[writing complete]\n"); }
  fail(reason: string): void { if (this.output.isTTY === true) this.output.write(`\n\n[writing incomplete: ${reason}]\n`); }
}
