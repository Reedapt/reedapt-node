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
export type BatchCompletedEvent = EventBase<"batch.completed", { batch: BatchSummary }>;
export type WebhookTestEvent = EventBase<"webhook.test", Record<string, unknown>>;

/** New event types may be added; handle the ones you know and ignore the rest. */
export type WebhookEvent =
  | DubCompletedEvent
  | DubFailedEvent
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
