// Sonar / Module 1 (bot constructor) — shared TS contract.
// Row types mirror src/schema.sql field-for-field; FlowDefinition mirrors
// React Flow's { nodes, edges } shape so the future canvas editor can
// read/write it directly with no translation layer.

// ---- Flow graph (FlowDefinition) ------------------------------------

export type NodeId = string;

export interface Position {
  x: number;
  y: number;
}

export interface TriggerNode {
  id: NodeId;
  type: 'trigger';
  position: Position;
  data: {
    keyword: string;
    matchType: 'contains' | 'exact';
  };
}

export interface SendMessageNode {
  id: NodeId;
  type: 'send_message';
  position: Position;
  data: {
    text: string;
    // set when the 24h DM window has expired and there's still a way to
    // reach the subscriber; if absent, the run fails instead of sending.
    fallbackChannel?: 'comment_reply';
  };
}

export type FlowNode = TriggerNode | SendMessageNode;

export interface FlowEdge {
  id: string;
  source: NodeId;
  target: NodeId;
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ---- Domain / DB row types (mirror schema.sql) -----------------------

export interface Tenant {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

export type Platform = 'instagram';

export interface Bot {
  id: string;
  tenant_id: string;
  name: string;
  platform: Platform;
  external_account_id: string | null;
  created_at: string;
}

export type FlowStatus = 'draft' | 'published';

export interface Flow {
  id: string;
  bot_id: string;
  version: number;
  definition: FlowDefinition;
  status: FlowStatus;
  created_at: string;
}

export type MatchType = 'contains' | 'exact';

export interface Trigger {
  id: string;
  bot_id: string;
  flow_id: string;
  flow_version: number;
  keyword: string;
  match_type: MatchType;
  is_active: boolean;
  created_at: string;
}

export type LeadStatus = 'new' | 'in_progress' | 'client';

export interface Subscriber {
  id: string;
  tenant_id: string;
  bot_id: string;
  external_user_id: string;
  first_seen_at: string;
  last_interacted_at: string;
  lead_status: LeadStatus;
}

export interface WebhookEvent {
  event_id: string;
  bot_id: string;
  payload: unknown;
  received_at: string;
  processed_at: string | null;
}

export type FlowRunStatus = 'running' | 'completed' | 'failed';

// Closed set of failure reasons, not a free-form string — a typo here
// would silently break analytics/alerting that filters on this field.
export type FlowRunFailureReason =
  | 'outside_24h_window_no_fallback_configured'
  | 'flow_not_found'
  | 'internal_error';

export interface FlowRun {
  id: string;
  tenant_id: string;
  bot_id: string;
  trigger_id: string;
  subscriber_id: string;
  flow_id: string;
  flow_version: number;
  run_date: string; // YYYY-MM-DD, subscriber-local trigger day
  status: FlowRunStatus;
  failure_reason: FlowRunFailureReason | null;
  started_at: string;
  completed_at: string | null;
}

export type MessageChannel = 'dm' | 'comment_fallback';

export interface MockSentMessage {
  id: string;
  flow_run_id: string;
  subscriber_id: string;
  channel: MessageChannel;
  content: string;
  sent_at: string;
}

// ---- Module 2: CRM and audience database ------------------------------

export interface Tag {
  id: string;
  tenant_id: string;
  name: string;
  created_at: string;
}

export interface Note {
  id: string;
  subscriber_id: string;
  tenant_id: string;
  body: string;
  created_at: string;
}

export type MessageDirection = 'in' | 'out';

export interface ConversationMessage {
  id: string;
  tenant_id: string;
  bot_id: string;
  subscriber_id: string;
  direction: MessageDirection;
  content: string;
  created_at: string;
}

// ---- Module 3: Reel analysis and script adaptation (mocked) -----------

export interface StructureBeat {
  label: string;
  timestampSeconds: number;
}

export interface ReelAnalysis {
  id: string;
  tenant_id: string;
  source_url: string;
  hook: string;
  duration_seconds: number;
  on_screen_text: string;
  structure: StructureBeat[];
  created_at: string;
}

export interface GeneratedScript {
  id: string;
  tenant_id: string;
  analysis_id: string;
  niche: string;
  script_text: string;
  created_at: string;
}

// ---- Module 4: Carousel generation (mocked LLM text) -------------------

export interface BrandPreset {
  id: string;
  tenant_id: string;
  name: string;
  font_family: string;
  primary_color: string;
  secondary_color: string;
  logo_url: string | null;
  created_at: string;
}

export interface Carousel {
  id: string;
  tenant_id: string;
  prompt: string;
  preset_id: string | null;
  created_at: string;
}

export interface CarouselSlide {
  id: string;
  carousel_id: string;
  tenant_id: string;
  position: number;
  headline: string;
  body: string;
  created_at: string;
}

// ---- Module 5: Cross-platform autoposting (mocked) ----------------------

export type PostingPlatform = 'instagram' | 'tiktok' | 'youtube_shorts';
// 'publishing' is a transient claim state — a row sits in it only for the
// duration of publishDuePosts' processing, never observed at rest.
export type ScheduledPostStatus = 'pending_approval' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'rejected';
export type PublishFailureReason = 'token_expired' | 'rejected_by_platform' | 'rate_limited';

export interface ScheduledPost {
  id: string;
  tenant_id: string;
  platform: PostingPlatform;
  caption: string;
  scheduled_at: string;
  requires_approval: boolean;
  status: ScheduledPostStatus;
  claimed_at: string | null;
  failure_reason: PublishFailureReason | null;
  published_at: string | null;
  external_post_url: string | null;
  created_at: string;
}

// ---- Module 8: Video editing, Levels 1-2 (mocked) -----------------------

// 'ai_smart_cut' is the Level-3 (own FFmpeg engine) pipeline; the other two
// are the Level-1/2 presets that go to Shotstack/Creatomate. They share one
// table and one status contract so the frontend has a single list to render.
export type VideoTemplate = 'auto_crop_916' | 'template_with_transitions' | 'ai_smart_cut';
// 'awaiting_review' is a real resting state, not a transient one: the job
// stays there until a person approves the captions.
export type VideoJobStatus = 'processing' | 'awaiting_review' | 'completed' | 'failed';
export type VideoPipeline = 'preset' | 'smart_cut';
export type VideoStage = 'probe' | 'transcribe' | 'plan_cuts' | 'subtitles' | 'render' | 'upload';

// Machine-readable, like Module 5's PublishFailureReason — the frontend maps
// these to Russian copy, so the wording can change without a data migration.
export type VideoFailureReason =
  | 'video_processing_error'
  | 'storage_not_configured'
  | 'ffmpeg_not_available'
  | 'source_unreadable'
  | 'source_missing'
  | 'no_audio_track'
  | 'video_too_long'
  | 'transcription_not_configured'
  | 'audio_too_large'
  | 'transcription_failed'
  | 'transcription_quota_exhausted'
  | 'nothing_to_cut'
  | 'render_failed'
  | 'upload_failed';

// Per-stage checkpoints, accumulated in video_edit_jobs.artifacts. Each stage
// writes its own key and never rewrites an earlier one, which is what lets a
// retry skip straight to the stage that failed.
export interface VideoJobArtifacts {
  probe?: { durationSec: number; hasAudio: boolean; width: number | null; height: number | null };
  transcript?: { words: Array<{ word: string; start: number; end: number }>; language: string | null };
  plan?: {
    segments: Array<{ start: number; end: number }>;
    keptDurationSec: number;
    removedDurationSec: number;
    droppedFillerCount: number;
    degraded: boolean;
  };
  // Why the audio was or was not cleaned, so the UI can say so instead of
  // leaving the decision invisible.
  noise?: { headroomDb: number; denoised: boolean };
  // What the signal-level pass removed, so the card can say so — the user
  // asked for breaths to go and otherwise has no way to tell whether any
  // were found.
  breaths?: { count: number; removedSec: number };
  subtitles?: { chunkCount: number; wordCount: number };
  // The caption lines as the viewer will see them — already remapped onto the
  // output timeline, so what is edited here is exactly what gets burned in.
  // Present only for jobs that asked for a review; `approved` flips when the
  // user confirms, which is what lets the worker move past the pause.
  captions?: {
    approved: boolean;
    lines: Array<{ start: number; end: number; text: string }>;
  };
}

export interface VideoEditJob {
  id: string;
  tenant_id: string;
  source_video_url: string;
  template: VideoTemplate;
  status: VideoJobStatus;
  progress_percent: number;
  output_url: string | null;
  poster_url: string | null;
  failure_reason: VideoFailureReason | null;
  created_at: string;
  completed_at: string | null;
  pipeline: VideoPipeline;
  source_object_key: string | null;
  output_object_key: string | null;
  stage: VideoStage | null;
  artifacts: VideoJobArtifacts;
  attempt_count: number;
  claimed_at: string | null;
  subtitles: boolean;
  denoise_mode: 'auto' | 'on' | 'off';
  review_mode: 'auto' | 'always' | 'never';
  subtitle_preset: string;
  subtitle_position: string;
  remove_breaths: boolean;
}

// ---- Push notifications (shared by Modules 5 and 8) ----------------------

export interface PushSubscriptionRecord {
  id: string;
  tenant_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export type NotificationType = 'post_published' | 'post_failed' | 'post_pending_approval' | 'video_completed' | 'video_failed';

export interface AppNotification {
  id: string;
  tenant_id: string;
  type: NotificationType;
  message: string;
  related_id: string | null;
  is_read: boolean;
  created_at: string;
}

// ---- Auth (Логика Б: public self-serve signup) ----------------------------

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  // Sign-in throttling — see loginThrottle.ts.
  failed_logins: number;
  locked_until: string | null;
  created_at: string;
}
