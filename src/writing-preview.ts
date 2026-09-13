import { systemClock, type PreviewClock, type PreviewOutput } from "./cli-preview.js";

type Label = "waiting for model" | "thinking";

/** Dim, then back to the terminal's own weight — reasoning is not the piece. */
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";

/**
* Terminal-only view of a write run: a transient elapsed-time status line until
* the model says something, its reasoning dimmed as it streams, then an
* append-only view of the prose.
*
* The status line is there because a slow upstream call can leave a person
* staring at nothing for minutes; it never claims a phase the caller has not
* observed (see `thinking`). Reasoning replaces it as soon as there is real
* text, so a run that returns no prose still shows what the tokens bought.
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

  /** Renders the waiting status and its one-second refresh. Idempotent. */
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
  * Streams the model's reasoning, dimmed, under a heading of its own. Shown and
  * nothing more: never returned, saved, or counted as prose. Ignored once prose
  * has started, since interleaving the two would corrupt the piece on screen.
  */
  reasoning(delta: string): void {
    if (!this.enabled || delta === "" || this.wrote) return;
    if (!this.reasoned) {
      // Reasoning is real output, so the placeholder has done its job.
      this.stopTimer();
      if (this.started) this.output.write("\r\x1b[2K");
      this.output.write(`${DIM}thinking${UNDIM}\n`);
      this.reasoned = true;
    }
    // Dimmed per delta, so an interrupted run cannot leave the terminal dim.
    this.output.write(`${DIM}${delta}${UNDIM}`);
  }

  update(delta: string): void {
    if (!this.enabled || delta === "") return;
    if (!this.wrote) {
      // First prose: stop the timer, then close off the reasoning or clear the
      // status line, whichever is on screen.
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
