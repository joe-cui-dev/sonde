import type { ReportPreview } from "./types.js";

/** The small writable interface needed for terminal-only report previews. */
export interface PreviewOutput {
  readonly isTTY?: boolean;
  write(chunk: string): boolean;
}

export interface PreviewClock {
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

const systemClock: PreviewClock = {
  now: () => Date.now(),
  setInterval,
  clearInterval,
};

/**
 * Presents an append-only preview on interactive stderr.
 *
 * Keeping the generated text in the terminal scrollback is intentional: a
 * provider, validation, or output-delivery failure must not retract content a
 * person has already seen. stdout remains exclusively for the final result.
 */
export class ReportPreviewRenderer {
  private started = false;
  private report = "";
  private startedAt = 0;
  private waitingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly output: PreviewOutput,
    private readonly clock: PreviewClock = systemClock,
  ) {}

  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.startedAt = this.clock.now();
    this.renderWaiting();
    this.waitingTimer = this.clock.setInterval(() => this.renderWaiting(), 1_000);
  }

  update(preview: ReportPreview): void {
    if (!this.enabled) return;
    this.start();
    if (typeof preview.report !== "string") return;
    this.stopWaiting();

    // Structured partial outputs are cumulative snapshots. Write only the
    // newly observed suffix; if parsing revises text, retain the displayed
    // snapshot instead of trying to rewrite terminal history.
    if (preview.report.startsWith(this.report)) {
      this.output.write(preview.report.slice(this.report.length));
    } else if (preview.report !== this.report) {
      this.output.write(`\n\n[preview updated]\n${preview.report}`);
    }
    this.report = preview.report;
  }

  fail(reason: string): void {
    if (!this.enabled || !this.started) return;
    this.stopWaiting();
    this.output.write(`\n\n[preview incomplete / not validated: ${reason}]\n`);
  }

  complete(): void {
    if (!this.enabled || !this.started) return;
    this.stopWaiting();
    this.output.write("\n\n[preview validated; final report delivered]\n");
  }

  private get enabled(): boolean {
    return this.output.isTTY === true;
  }

  private renderWaiting(): void {
    if (!this.enabled || this.report) return;
    const elapsed = Math.floor((this.clock.now() - this.startedAt) / 1_000);
    this.output.write(
      `\r\x1b[2KReport preview (in progress; not yet validated) · waiting ${elapsed}s`,
    );
  }

  private stopWaiting(): void {
    if (this.waitingTimer !== undefined) {
      this.clock.clearInterval(this.waitingTimer);
      this.waitingTimer = undefined;
      this.output.write("\r\x1b[2K\nReport preview (in progress; not yet validated)\n\n");
    }
  }
}
