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

/** The real clock, shared by every terminal renderer that needs one. */
export const systemClock: PreviewClock = {
  now: () => Date.now(),
  setInterval,
  clearInterval,
};

/**
* An append-only preview on interactive stderr. Text stays in the scrollback on
* purpose: a provider, validation, or delivery failure must not retract what a
* person has already seen. stdout stays exclusively for the final result.
*/
export class ReportPreviewRenderer {
  private started = false;
  private shown = "";
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
    this.waitingTimer = this.clock.setInterval(
      () => this.renderWaiting(),
      1_000,
    );
  }

  update(preview: ReportPreview): void {
    if (!this.enabled) return;
    this.start();

    // The summary is the schema's first field, so it is the whole preview for as
    // long as the writer is on it — often most of the stream. Showing only
    // `report` left the waiting indicator up while text was arriving.
    const text = [preview.summary, preview.report]
      .filter((part): part is string => typeof part === "string")
      .join("\n\n");
    if (!text) return;
    this.stopWaiting();

    // Partial outputs are cumulative snapshots, so write only the new suffix.
    // If parsing revises the text, keep what was shown rather than rewriting
    // terminal history.
    if (text.startsWith(this.shown)) {
      this.output.write(text.slice(this.shown.length));
    } else if (text !== this.shown) {
      this.output.write(`\n\n[preview updated]\n${text}`);
    }
    this.shown = text;
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
    if (!this.enabled || this.shown) return;
    const elapsed = Math.floor((this.clock.now() - this.startedAt) / 1_000);
    this.output.write(
      `\r\x1b[2KReport preview (in progress; not yet validated) · waiting ${elapsed}s`,
    );
  }

  private stopWaiting(): void {
    if (this.waitingTimer !== undefined) {
      this.clock.clearInterval(this.waitingTimer);
      this.waitingTimer = undefined;
      this.output.write(
        "\r\x1b[2K\nReport preview (in progress; not yet validated)\n\n",
      );
    }
  }
}
