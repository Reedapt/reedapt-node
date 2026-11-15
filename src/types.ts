// Shapes returned by the API. Objects may gain fields over time, so treat
// unknown fields as normal and don't rely on the absence of a key.

export type UploadStatus = "uploading" | "fetching" | "uploaded" | "used" | "failed";

export interface PartLink {
  part_number: number;
  url: string;
}

export interface Upload {
  id: string;
  object?: "upload";
  filename: string;
  size: number;
  status: UploadStatus;
  error?: string | null;
  part_size: number;
  part_count: number;
  parts?: PartLink[];
  parts_expire_at?: string | null;
}

export interface UploadedPart {
  part_number: number;
  etag: string;
}

export type DubStatus = "queued" | "processing" | "completed" | "failed";

export interface DubError {
  code: string;
  message: string;
}

export interface Dub {
  id: string;
  object?: "dub";
  status: DubStatus;
  stage?: string | null;
  progress: number;
  source_language: string | null;
  target_language: string | null;
  audio: boolean;
  test: boolean;
  preview_seconds?: number | null;
  duration_minutes?: number | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error?: DubError | null;
  metadata?: Record<string, string>;
}

export interface RefusedLanguage {
  target_language: string;
  code: string;
  message: string;
}

export interface DubsCreated {
  dubs: Dub[];
  refused?: RefusedLanguage[];
}

export interface DubList {
  data: Dub[];
  has_more: boolean;
}

export type FileKind = "dub" | "dubbed_audio_wav" | "voice" | "background";

export interface FileLink {
  kind: FileKind;
  filename: string;
  url: string;
}

export interface DubFiles {
  files: FileLink[];
  expires_at: string;
}

export interface TranscriptLine {
  start_ms: number;
  end_ms: number;
  /** The same label throughout a dub, such as `SPEAKER_00`. */
  speaker?: string | null;
  original_text: string;
  /** The line in the dub's language. */
  text: string;
}

/** A completed dub's lines in time order, edits made in the editor included. */
export interface Transcript {
  dub_id: string;
  source_language?: string | null;
  target_language?: string | null;
  lines: TranscriptLine[];
}

export interface SubtitlesParams {
  /** Defaults to `srt`. */
  format?: "srt" | "vtt";
  /** `target` (the default) for the dub's language, `source` for the original words. */
  language?: "target" | "source";
}

/** How a line that Reedapt flagged was dealt with, if it was. */
export type QualityFix = "shortened" | "revoiced";

export interface FlaggedLine {
  line: number;
  start_ms: number;
  /** What the checks found, such as `fit` (the line doesn't fit its time). */
  checks: string[];
  fixed: QualityFix | null;
}

/** Reedapt's check of a finished dub. */
export interface Quality {
  dub_id: string;
  /** Whether the measurement checks have run. */
  checked: boolean;
  listened: boolean;
  lines: number;
  fixed: number;
  to_review: number;
  flagged: FlaggedLine[];
}

export type RunStatus = "done" | "needs_input" | "applied" | "declined" | "failed";
export type RunChoice = "apply" | "decline";
/** `ask` waits for your answer before changing anything; `decide` lets Reedapt apply changes itself. */
export type Autonomy = "ask" | "decide";

export interface RunProposal {
  kind: string;
  summary: string;
  /** How many lines it would change. */
  lines: number;
}

export interface RunOption {
  id: RunChoice;
  label: string;
}

/** A request for changes to a dub, and what Reedapt did or proposes to do about it. */
export interface Run {
  id: string;
  object?: "run";
  dub_id: string;
  status: RunStatus;
  request: string;
  reply: string;
  /** Present while `status` is `needs_input`. */
  proposal?: RunProposal | null;
  options?: RunOption[] | null;
  /** How many lines were changed, once the run is `applied`. They are voiced again in the background. */
  applied_lines?: number | null;
  created_at: string;
}

export interface CreateRunParams {
  text: string;
  /** Defaults to `ask`. */
  autonomy?: Autonomy;
}

export interface AnswerRunParams {
  choice: RunChoice;
}

export interface DubLine {
  /** The line's number in time order, starting at 1. */
  line: number;
  start_ms: number;
  end_ms: number;
  speaker?: string | null;
  original_text: string;
  /** The line in the dub's language. */
  text: string;
  delivery_style?: string | null;
  voice_instructions?: string | null;
}

export interface DubLines {
  dub_id: string;
  lines: DubLine[];
}

export interface LineEdit {
  line: number;
  /** New wording, in the dub's language. */
  text?: string;
  /** For example `angry` or `whisper`. `null` clears it. */
  delivery_style?: string | null;
  /** How to say it, in plain words. Up to 300 characters. */
  voice_instructions?: string | null;
}

export interface EditLinesParams {
  /** At most 100 lines. */
  lines: LineEdit[];
}

export interface LinesEdited {
  dub_id: string;
  /** The lines being voiced again. */
  lines: number[];
  status: "revoicing";
}

export interface Languages {
  target_languages: string[];
}

export interface Usage {
  plan?: string | null;
  key_mode: "live" | "test";
  minutes_remaining?: number | null;
  unlimited: boolean;
  test_preview_seconds: number;
}

export interface DubCounts {
  completed: number;
  in_progress: number;
  /** Failed or cancelled. Their minutes were returned. */
  failed: number;
}

export interface UsageCounts {
  /** Minutes used by completed dubs. Test dubs are free. */
  minutes: number;
  /** Minutes reserved by dubs that haven't finished. */
  minutes_in_progress: number;
  dubs: DubCounts;
}

/** One month of the account's API usage. A dub counts in the month it started (UTC). */
export interface UsageReport extends UsageCounts {
  month: string;
  period_start: string;
  period_end: string;
  keys: (UsageCounts & { key_id: string | null; mode: "live" | "test" })[];
  languages: (UsageCounts & { target_language: string | null })[];
}

export interface WebhookEndpoint {
  id: string;
  object?: "webhook_endpoint";
  url: string;
  description?: string | null;
  events: string[];
  created_at: string;
  /** Only on the endpoint returned by `create`. Keep it to check signatures. */
  secret?: string | null;
}

export interface WebhookEndpointList {
  data: WebhookEndpoint[];
}

export interface WebhookDelivery {
  id: string;
  event_id: string;
  event_type: string;
  status: "pending" | "delivered" | "failed" | string;
  attempts: number;
  last_status_code?: number | null;
  last_error?: string | null;
  next_attempt_at?: string | null;
  created_at: string;
  delivered_at?: string | null;
}

export interface WebhookDeliveryList {
  data: WebhookDelivery[];
}

export interface BatchSummary {
  batch_id: string;
  status: string;
  video_count: number;
  jobs_total: number;
  jobs_done: number;
  jobs_failed: number;
  dubs: Dub[];
}

interface EventBase<T extends string, D> {
  id: string;
  type: T;
  created_at: string;
  data: D;
}

export type DubCompletedEvent = EventBase<"dub.completed", { dub: Dub }>;
export type DubFailedEvent = EventBase<"dub.failed", { dub: Dub }>;
export type DubCheckedEvent = EventBase<"dub.checked", { dub: Dub; quality: Quality }>;
export type BatchCompletedEvent = EventBase<"batch.completed", { batch: BatchSummary }>;
export type WebhookTestEvent = EventBase<"webhook.test", Record<string, unknown>>;

/** New event types may be added; handle the ones you know and ignore the rest. */
export type WebhookEvent =
  | DubCompletedEvent
  | DubFailedEvent
  | DubCheckedEvent
  | BatchCompletedEvent
  | WebhookTestEvent
  | EventBase<string, Record<string, unknown>>;

export interface CreateUploadParams {
  filename?: string;
  size?: number;
  source_url?: string;
}

export interface CreateDubsParams {
  upload_id: string;
  source_language: string;
  target_languages: string[];
  voice_cloning?: boolean;
  num_speakers?: number;
  media_category?: string;
  /** Notes for the dub, up to 2000 characters: names to keep, tone, how to address the audience. Followed on paid plans. */
  instructions?: string;
  metadata?: Record<string, string>;
}

export interface ListDubsParams {
  limit?: number;
  offset?: number;
}

export interface CreateWebhookEndpointParams {
  url: string;
  description?: string;
}
