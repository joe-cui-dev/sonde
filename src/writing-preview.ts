import { systemClock, type PreviewClock, type PreviewOutput } from "./cli-preview.js";

type Label = "waiting for model" | "thinking";

/**
 * Terminal-only view of a write run: a transient elapsed-time status line
 * until the first prose arrives, then an append-only view of the prose
 * itself.
 *
 * The status line exists because a slow upstream call can leave an
 * interactive user staring at nothing for minutes; it never claims a phase
 * the caller has not actually observed (see `thinking`).
 */
export class WritingPreviewRenderer {
  private wrote = false;
  private started = false;
  private startedAt = 0;
  private label: Label = "waiting for model";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly output: PreviewOutput,
    private readonly clock: PreviewClock = systemClock,
  ) {}

  /** Whether any prose has actually reached the terminal through this renderer. */
  get streamed(): boolean { return this.wrote; }

  /**
   * Renders the transient waiting status and starts its one-second elapsed
   * refresh. Idempotent: a later call while already started (or after prose
   * has begun) does nothing.
   */
  start(): void {
    if (!this.enabled || this.started || this.wrote) return;
    this.started = true;
    this.startedAt = this.clock.now();
    this.render();
    this.timer = this.clock.setInterval(() => this.render(), 1_000);
  }

  /** Switches the transient label to `thinking`, called on an observed reasoning phase event. */
  thinking(): void {
    this.start();
    if (!this.enabled || this.wrote) return;
    this.label = "thinking";
    this.render();
  }

  update(delta: string): void {
    if (!this.enabled || delta === "") return;
    if (!this.wrote) {
      // First prose: clear the transient status line, if one is actually on
      // screen, and stop its timer before anything else touches the terminal.
      this.stopTimer();
      if (this.started) this.output.write("\r\x1b[2K");
      this.wrote = true;
    }
    this.output.write(delta);
  }

  complete(): void {
    this.stopTimer();
    if (this.enabled) this.output.write("\n\n[writing complete]\n");
  }

  fail(reason: string): void {
    this.stopTimer();
    if (this.enabled) this.output.write(`\n\n[writing incomplete: ${reason}]\n`);
  }

  private get enabled(): boolean {
    return this.output.isTTY === true;
  }

  private render(): void {
    if (!this.enabled || this.wrote) return;
    const elapsed = Math.floor((this.clock.now() - this.startedAt) / 1_000);
    this.output.write(`\r\x1b[2KWriting · ${this.label} · ${elapsed}s · Ctrl-C to cancel`);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
