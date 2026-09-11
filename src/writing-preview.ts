import { systemClock, type PreviewClock, type PreviewOutput } from "./cli-preview.js";

type Label = "waiting for model" | "thinking";

/** Dim, then back to the terminal's own weight — reasoning is not the piece. */
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";

/**
 * Terminal-only view of a write run: a transient elapsed-time status line
 * until the model says something, the model's reasoning dimmed as it streams,
 * then an append-only view of the prose itself.
 *
 * The status line exists because a slow upstream call can leave an
 * interactive user staring at nothing for minutes; it never claims a phase
 * the caller has not actually observed (see `thinking`). Reasoning replaces
 * it as soon as there is real text to show, because a run that spends its
 * whole completion thinking and returns nothing should not leave a person
 * with a token bill and no idea what was bought.
 */
export class WritingPreviewRenderer {
  private wrote = false;
  private reasoned = false;
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
    if (!this.enabled || this.wrote || this.reasoned) return;
    this.label = "thinking";
    this.render();
  }

  /**
   * Streams the model's reasoning, dimmed, under a heading of its own. The
   * text is shown and nothing more: it is never returned, saved, or counted as
   * prose. Ignored once prose has started — by then the thinking is history,
   * and interleaving the two would corrupt the piece on screen.
   */
  reasoning(delta: string): void {
    if (!this.enabled || delta === "" || this.wrote) return;
    if (!this.reasoned) {
      // Reasoning is real output, so the elapsed-time placeholder has done its
      // job: retire it and its timer before the first word lands.
      this.stopTimer();
      if (this.started) this.output.write("\r\x1b[2K");
      this.output.write(`${DIM}thinking${UNDIM}\n`);
      this.reasoned = true;
    }
    // Dimmed per delta rather than once around the whole block, so an
    // interrupted run cannot leave the terminal stuck in dim.
    this.output.write(`${DIM}${delta}${UNDIM}`);
  }

  update(delta: string): void {
    if (!this.enabled || delta === "") return;
    if (!this.wrote) {
      // First prose: stop the status timer, then either close off the
      // reasoning above with a blank line or clear the transient status line,
      // whichever is actually on screen.
      this.stopTimer();
      if (this.reasoned) this.output.write("\n\n");
      else if (this.started) this.output.write("\r\x1b[2K");
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
    if (!this.enabled || this.wrote || this.reasoned) return;
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
