import type { Db } from "./db.js";
import type {
  BudgetSnapshot,
  ResearchReport,
  SourceRef,
  StopReason,
  VideoRecord,
} from "../types.js";

export class RunStore {
  constructor(private readonly db: Db) {}

  start(
    runId: string,
    question: string,
    kind: "research" | "writing" | "video" = "research",
  ): void {
    this.db
      .prepare("INSERT INTO runs (id, question, started_at, kind) VALUES (?, ?, ?, ?)")
      .run(runId, question, Date.now(), kind);
  }

  finishWrite(
    runId: string,
    stoppedBy: StopReason,
    usage: BudgetSnapshot,
    text: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, stopped_by = ?, usd = ?, total_tokens = ?,
         search_credits = ?, report_json = ? WHERE id = ?`,
      )
      .run(
        Date.now(), stoppedBy, usage.usd, usage.totalTokens,
        usage.searchCredits, text, runId,
      );
  }

  /**
  * A video run's record, saved at every change rather than once at the end:
  * the job id has to be on disk before anything else can go wrong, since the
  * job is paid for from the moment it is submitted.
  */
  saveVideo(
    runId: string,
    record: VideoRecord,
    stoppedBy: StopReason | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, stopped_by = ?, usd = ?, total_tokens = 0,
         search_credits = 0, report_json = ? WHERE id = ?`,
      )
      .run(
        stoppedBy ? Date.now() : null, stoppedBy, record.costUsd,
        safeJson(record), runId,
      );
  }

  /** A video run's record, or null when the id names no video run. */
  video(runId: string): { direction: string; stoppedBy: StopReason | null; record: VideoRecord } | null {
    const row = this.db
      .prepare("SELECT question, stopped_by, report_json FROM runs WHERE id = ? AND kind = 'video'")
      .get(runId) as { question: string; stopped_by: StopReason | null; report_json: string | null } | undefined;
    if (!row?.report_json) return null;
    return {
      direction: row.question,
      stoppedBy: row.stopped_by,
      record: JSON.parse(row.report_json) as VideoRecord,
    };
  }

  event(runId: string, type: string, payload: unknown): void {
    this.db
      .prepare(
        "INSERT INTO run_events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)",
      )
      .run(runId, Date.now(), type, safeJson(payload));
  }

  saveSource(runId: string, source: SourceRef): void {
    this.db
      .prepare(
        `INSERT INTO sources (run_id, sid, url, title, score, published_date, was_read)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, sid) DO UPDATE SET
           title = excluded.title,
           score = excluded.score,
           published_date = excluded.published_date,
           was_read = MAX(sources.was_read, excluded.was_read)`,
      )
      .run(
        runId,
        source.id,
        source.url,
        source.title,
        source.score ?? null,
        source.publishedDate ?? null,
        source.read ? 1 : 0,
      );
  }

  finish(
    runId: string,
    stoppedBy: StopReason,
    usage: BudgetSnapshot,
    report: ResearchReport | null,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, stopped_by = ?, usd = ?, total_tokens = ?,
                         search_credits = ?, report_json = ?
         WHERE id = ?`,
      )
      .run(
        Date.now(),
        stoppedBy,
        usage.usd,
        usage.totalTokens,
        usage.searchCredits,
        report ? safeJson(report) : null,
        runId,
      );
  }

  recent(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, question, kind, started_at, finished_at, stopped_by, usd, total_tokens, search_credits
         FROM runs ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}
