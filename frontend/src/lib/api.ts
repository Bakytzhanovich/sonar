// Thin client for the Sonar Module 1 backend (src/api.ts in the sibling
// project). Types here are a deliberate, small duplicate of the backend's
// src/types.ts — this is two files, not worth a shared workspace package
// at this project size; revisit if the type surface grows.

export type MatchType = 'contains' | 'exact';
export type FallbackChannel = 'comment_reply';

export interface TriggerNodeData {
  keyword: string;
  matchType: MatchType;
}

export interface SendMessageNodeData {
  text: string;
  fallbackChannel?: FallbackChannel;
}

export interface FlowDefinitionNode {
  id: string;
  type: 'trigger' | 'send_message';
  position: { x: number; y: number };
  data: TriggerNodeData | SendMessageNodeData;
}

export interface FlowDefinitionEdge {
  id: string;
  source: string;
  target: string;
}

export interface FlowDefinition {
  nodes: FlowDefinitionNode[];
  edges: FlowDefinitionEdge[];
}

export interface Bot {
  id: string;
  tenant_id: string;
  name: string;
  platform: string;
  external_account_id: string | null;
  created_at: string;
}

export interface PublishedFlow {
  id: string;
  bot_id: string;
  version: number;
  definition: FlowDefinition;
  status: 'published';
  created_at: string;
}

export interface ActiveTrigger {
  id: string;
  bot_id: string;
  flow_id: string;
  flow_version: number;
  keyword: string;
  match_type: MatchType;
  is_active: boolean;
  created_at: string;
}

export interface SentMessage {
  channel: 'dm' | 'comment_fallback';
  content: string;
}

export type RunFlowOutcome =
  | { status: 'no_trigger_match' }
  | { status: 'duplicate_today'; triggerId: string }
  | { status: 'failed'; triggerId: string; flowRunId?: string; failureReason: string }
  | { status: 'completed'; triggerId: string; flowRunId?: string; sentMessages: SentMessage[] };

export interface DemoWorkspace {
  bot: Bot;
  flow: PublishedFlow;
  trigger: ActiveTrigger;
}

export type LeadStatus = 'new' | 'in_progress' | 'client';

export interface Tag {
  id: string;
  name: string;
}

export interface Subscriber {
  id: string;
  tenant_id: string;
  bot_id: string;
  external_user_id: string;
  first_seen_at: string;
  last_interacted_at: string;
  lead_status: LeadStatus;
  tags: Tag[];
}

export interface Note {
  id: string;
  subscriber_id: string;
  body: string;
  created_at: string;
}

export interface ConversationMessage {
  direction: 'in' | 'out';
  content: string;
  created_at: string;
}

export interface StructureBeat {
  label: string;
  timestampSeconds: number;
}

export interface ReelAnalysis {
  id: string;
  source_url: string;
  hook: string;
  duration_seconds: number;
  on_screen_text: string;
  structure: StructureBeat[];
  created_at: string;
}

export interface GeneratedScript {
  id: string;
  analysis_id: string;
  niche: string;
  script_text: string;
  created_at: string;
}

export interface BrandPreset {
  id: string;
  name: string;
  font_family: string;
  primary_color: string;
  secondary_color: string;
  logo_url: string | null;
}

export interface Carousel {
  id: string;
  prompt: string;
  preset_id: string | null;
  created_at: string;
}

export interface CarouselSlide {
  id: string;
  carousel_id: string;
  position: number;
  headline: string;
  body: string;
}

export type PostingPlatform = 'instagram' | 'tiktok' | 'youtube_shorts';
export type ScheduledPostStatus = 'pending_approval' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'rejected';

export interface ScheduledPost {
  id: string;
  platform: PostingPlatform;
  caption: string;
  scheduled_at: string;
  requires_approval: boolean;
  status: ScheduledPostStatus;
  failure_reason: string | null;
  published_at: string | null;
  external_post_url: string | null;
  created_at: string;
}

// 'ai_smart_cut' is the Level-3 pipeline (own ffmpeg engine): real cutting,
// real transcription, burned-in captions. The other two are the mocked
// Shotstack/Creatomate presets.
export type VideoTemplate = 'auto_crop_916' | 'template_with_transitions' | 'ai_smart_cut';
export type VideoJobStatus = 'processing' | 'awaiting_review' | 'completed' | 'failed';
export type VideoStage = 'probe' | 'transcribe' | 'plan_cuts' | 'subtitles' | 'render' | 'upload';

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
  subtitles?: { chunkCount: number; wordCount: number };
  captions?: { approved: boolean; lines: Array<{ start: number; end: number; text: string }> };
  noise?: { headroomDb: number; denoised: boolean };
}

export interface VideoEditJob {
  id: string;
  source_video_url: string;
  template: VideoTemplate;
  status: VideoJobStatus;
  progress_percent: number;
  output_url: string | null;
  poster_url: string | null;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
  pipeline?: 'preset' | 'smart_cut';
  stage?: VideoStage | null;
  artifacts?: VideoJobArtifacts;
  subtitles?: boolean;
  denoise_mode?: 'auto' | 'on' | 'off';
  review_mode?: 'auto' | 'always' | 'never';
}

export interface VideoUploadTicket {
  objectKey: string;
  uploadUrl: string;
  contentType: string;
  expiresInSec: number;
  storage: 'r2' | 'local';
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type NotificationType = 'post_published' | 'post_failed' | 'post_pending_approval' | 'video_completed' | 'video_failed';

export interface AppNotification {
  id: string;
  type: NotificationType;
  message: string;
  related_id: string | null;
  is_read: boolean;
  created_at: string;
}

export interface ContentRecommendation {
  segment: string;
  subscriberCount: number;
  clientCount: number;
  conversionRate: number;
  matchingScriptCount: number;
  explanation: string;
}

export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
}

// Shared with useSession — kept as a literal here to avoid importing a React
// hook module into this transport layer.
const SESSION_STORAGE_KEY = 'sonar-session';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `request failed with ${status}`;
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function apiRequest(config: ApiConfig, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Only the dev-panel apiKey still travels in a header. The user's session
  // is an httpOnly cookie the page cannot read — it rides along because of
  // credentials below, and that is the point: script cannot steal what
  // script cannot see.
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // same-origin, not 'include': the proxy makes the API same-origin, and
    // 'include' would also send the cookie to any other host this ever
    // pointed at.
    credentials: 'same-origin',
  });

  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !config.apiKey) onSessionRejected();
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

// A 401 on a cookie-authenticated request means the stored session is a
// ghost: the browser has no valid cookie, but the page still holds the
// metadata written beside it. That happens when the cookie expires, when it
// is cleared, and — for everyone who signed in before the switch — when the
// session predates cookies entirely, because back then the token lived in
// localStorage and no cookie was ever set.
//
// Left alone, the UI reads that metadata as "signed in" and offers working
// buttons that 401 on every press. Clearing it is what turns a silent
// failure into a login screen. Only done when no apiKey was sent: with a key
// the 401 is about the key, not the session.
function onSessionRejected(): void {
  try {
    if (!localStorage.getItem(SESSION_STORAGE_KEY)) return;
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    return;
  }
  // Reload rather than route: every screen holds this state in a hook, and
  // a reload is the one thing guaranteed to re-read it everywhere at once.
  if (typeof window !== 'undefined') window.location.reload();
}

export const api = {
  createTenant: (config: ApiConfig, name: string, email: string) =>
    apiRequest(config, 'POST', '/api/tenants', { name, email }),

  // ---- Auth (Логика Б) ----------------------------------------------------
  signup: (config: ApiConfig, email: string, password: string) => apiRequest(config, 'POST', '/api/auth/signup', { email, password }),

  login: (config: ApiConfig, email: string, password: string) => apiRequest(config, 'POST', '/api/auth/login', { email, password }),

  // config.apiKey carries the session JWT here — apiRequest just sends
  // whatever it's given as a Bearer token, so no separate request helper
  // is needed for the two different token kinds.
  me: (config: ApiConfig) => apiRequest(config, 'GET', '/api/auth/me'),

  createBot: (config: ApiConfig, name: string, externalAccountId: string) =>
    apiRequest(config, 'POST', '/api/bots', { name, externalAccountId }),

  listBots: (config: ApiConfig) => apiRequest(config, 'GET', '/api/bots') as Promise<{ bots: Bot[] }>,

  createDemoWorkspace: (config: ApiConfig, keyword: string, replyText: string) =>
    apiRequest(config, 'POST', '/api/onboarding/demo-workspace', { keyword, replyText }) as Promise<DemoWorkspace>,

  listFlows: (config: ApiConfig, botId: string) => apiRequest(config, 'GET', `/api/bots/${botId}/flows`),

  createFlow: (config: ApiConfig, botId: string, definition: FlowDefinition) =>
    apiRequest(config, 'POST', `/api/bots/${botId}/flows`, { definition }),

  createFlowVersion: (config: ApiConfig, flowId: string, definition: FlowDefinition) =>
    apiRequest(config, 'POST', `/api/flows/${flowId}/versions`, { definition }),

  getFlowVersion: (config: ApiConfig, flowId: string, version: number) =>
    apiRequest(config, 'GET', `/api/flows/${flowId}/versions/${version}`),

  publishFlow: (config: ApiConfig, flowId: string, version: number) =>
    apiRequest(config, 'POST', `/api/flows/${flowId}/versions/${version}/publish`, {}),

  createTrigger: (config: ApiConfig, botId: string, body: { keyword: string; matchType: MatchType; flowId: string; flowVersion: number }) =>
    apiRequest(config, 'POST', `/api/bots/${botId}/triggers`, body),

  rollbackTrigger: (config: ApiConfig, triggerId: string, toVersion: number) =>
    apiRequest(config, 'POST', `/api/triggers/${triggerId}/rollback`, { toVersion }),

  testRun: (config: ApiConfig, botId: string, body: { externalUserId: string; messageText: string }) =>
    apiRequest(config, 'POST', `/api/bots/${botId}/test`, body) as Promise<{ outcome: RunFlowOutcome }>,

  createDemoInteraction: (config: ApiConfig, botId: string, messageText: string) =>
    apiRequest(config, 'POST', `/api/bots/${botId}/demo-interactions`, { messageText }) as Promise<{
      subscriberId: string;
      outcome: RunFlowOutcome;
    }>,

  dashboard: (config: ApiConfig, botId: string) => apiRequest(config, 'GET', `/api/bots/${botId}/dashboard`),

  // ---- Module 2: CRM ----------------------------------------------------

  listSubscribers: (config: ApiConfig, botId: string, filters: { tag?: string; leadStatus?: LeadStatus } = {}) => {
    const params = new URLSearchParams();
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.leadStatus) params.set('leadStatus', filters.leadStatus);
    const qs = params.toString();
    return apiRequest(config, 'GET', `/api/bots/${botId}/subscribers${qs ? `?${qs}` : ''}`) as Promise<{ subscribers: Subscriber[] }>;
  },

  updateLeadStatus: (config: ApiConfig, subscriberId: string, leadStatus: LeadStatus) =>
    apiRequest(config, 'PATCH', `/api/subscribers/${subscriberId}/lead-status`, { leadStatus }),

  getMessages: (config: ApiConfig, subscriberId: string) =>
    apiRequest(config, 'GET', `/api/subscribers/${subscriberId}/messages`) as Promise<{ messages: ConversationMessage[] }>,

  getNotes: (config: ApiConfig, subscriberId: string) =>
    apiRequest(config, 'GET', `/api/subscribers/${subscriberId}/notes`) as Promise<{ notes: Note[] }>,

  addNote: (config: ApiConfig, subscriberId: string, body: string) =>
    apiRequest(config, 'POST', `/api/subscribers/${subscriberId}/notes`, { body }),

  listTags: (config: ApiConfig, botId: string) => apiRequest(config, 'GET', `/api/bots/${botId}/tags`) as Promise<{ tags: Tag[] }>,

  addTag: (config: ApiConfig, subscriberId: string, name: string) =>
    apiRequest(config, 'POST', `/api/subscribers/${subscriberId}/tags`, { name }) as Promise<{ tag: Tag }>,

  removeTag: (config: ApiConfig, subscriberId: string, tagId: string) =>
    apiRequest(config, 'DELETE', `/api/subscribers/${subscriberId}/tags/${tagId}`),

  // Drives a REAL (non-test) inbound message through the same handler the
  // Instagram webhook uses, but over an authenticated, tenant-scoped route.
  //
  // This used to POST straight to /webhooks/mock/instagram with no
  // credential — which is precisely why that endpoint was reachable by
  // anyone. It is now secret-gated, and the secret must not live in a
  // browser bundle, so the product calls its own API instead: the bot is
  // resolved inside the caller's tenant and eventId is generated
  // server-side (a UI click is not a redelivered platform event).
  simulateIncoming: (config: ApiConfig, botId: string, externalUserId: string, messageText: string) =>
    apiRequest(config, 'POST', `/api/bots/${botId}/simulate-incoming`, { externalUserId, messageText }),

  // ---- Module 3: Reel analysis (mocked pipeline) -------------------------

  createAnalysis: (config: ApiConfig, sourceUrl: string) =>
    apiRequest(config, 'POST', '/api/reel-analyses', { sourceUrl }) as Promise<{ analysis: ReelAnalysis }>,

  listAnalyses: (config: ApiConfig) => apiRequest(config, 'GET', '/api/reel-analyses') as Promise<{ analyses: ReelAnalysis[] }>,

  generateScript: (config: ApiConfig, analysisId: string, niche: string) =>
    apiRequest(config, 'POST', `/api/reel-analyses/${analysisId}/scripts`, { niche }) as Promise<{ script: GeneratedScript }>,

  listScriptsForAnalysis: (config: ApiConfig, analysisId: string) =>
    apiRequest(config, 'GET', `/api/reel-analyses/${analysisId}/scripts`) as Promise<{ scripts: GeneratedScript[] }>,

  searchScriptsByNiche: (config: ApiConfig, niche: string) =>
    apiRequest(config, 'GET', `/api/scripts?niche=${encodeURIComponent(niche)}`) as Promise<{ scripts: GeneratedScript[] }>,

  // ---- Module 4: Carousel generation (mocked LLM text) -------------------

  createBrandPreset: (config: ApiConfig, name: string, fields: Partial<Omit<BrandPreset, 'id' | 'tenant_id' | 'created_at' | 'name'>> = {}) =>
    apiRequest(config, 'POST', '/api/brand-presets', {
      name,
      fontFamily: fields.font_family,
      primaryColor: fields.primary_color,
      secondaryColor: fields.secondary_color,
      logoUrl: fields.logo_url,
    }) as Promise<{ preset: BrandPreset }>,

  listBrandPresets: (config: ApiConfig) => apiRequest(config, 'GET', '/api/brand-presets') as Promise<{ presets: BrandPreset[] }>,

  createCarousel: (config: ApiConfig, prompt: string, presetId?: string) =>
    apiRequest(config, 'POST', '/api/carousels', { prompt, presetId }) as Promise<{ carousel: Carousel; slides: CarouselSlide[] }>,

  listCarousels: (config: ApiConfig) => apiRequest(config, 'GET', '/api/carousels') as Promise<{ carousels: Carousel[] }>,

  getCarousel: (config: ApiConfig, id: string) =>
    apiRequest(config, 'GET', `/api/carousels/${id}`) as Promise<{ carousel: Carousel; slides: CarouselSlide[] }>,

  updateSlide: (config: ApiConfig, carouselId: string, slideId: string, fields: { headline?: string; body?: string }) =>
    apiRequest(config, 'PATCH', `/api/carousels/${carouselId}/slides/${slideId}`, fields) as Promise<{ slide: CarouselSlide }>,

  // ---- Module 5: Cross-platform autoposting (mocked) ---------------------

  createScheduledPost: (
    config: ApiConfig,
    fields: { platform: PostingPlatform; caption: string; scheduledAt: string; requiresApproval?: boolean }
  ) => apiRequest(config, 'POST', '/api/scheduled-posts', fields) as Promise<{ post: ScheduledPost }>,

  listScheduledPosts: (config: ApiConfig) => apiRequest(config, 'GET', '/api/scheduled-posts') as Promise<{ posts: ScheduledPost[] }>,

  approvePost: (config: ApiConfig, id: string) =>
    apiRequest(config, 'POST', `/api/scheduled-posts/${id}/approve`) as Promise<{ post: ScheduledPost }>,

  rejectPost: (config: ApiConfig, id: string) =>
    apiRequest(config, 'POST', `/api/scheduled-posts/${id}/reject`) as Promise<{ post: ScheduledPost }>,

  processDuePosts: (config: ApiConfig) => apiRequest(config, 'POST', '/api/scheduled-posts/process-due') as Promise<{ processed: number }>,

  // ---- Module 6: Content plan from CRM + Module 3 -------------------------

  getContentRecommendations: (config: ApiConfig, segment?: string) =>
    apiRequest(config, 'GET', `/api/content-recommendations${segment ? `?segment=${encodeURIComponent(segment)}` : ''}`) as Promise<{
      recommendations: ContentRecommendation[];
    }>,

  // ---- Module 8: Video editing, Levels 1-2 (mocked) -----------------------

  createVideoJob: (config: ApiConfig, sourceVideoUrl: string, template: VideoTemplate) =>
    apiRequest(config, 'POST', '/api/video-edit-jobs', { sourceVideoUrl, template }) as Promise<{ job: VideoEditJob }>,

  // ---- Module 8, Level 3: own ffmpeg engine ------------------------------

  createVideoUpload: (config: ApiConfig, contentType: string) =>
    apiRequest(config, 'POST', '/api/video-uploads', { contentType }) as Promise<VideoUploadTicket>,

  // No denoise/review flags: the pipeline measures the recording and decides.
  createSmartCutJob: (config: ApiConfig, sourceObjectKey: string, subtitles: boolean) =>
    apiRequest(config, 'POST', '/api/video-edit-jobs', {
      template: 'ai_smart_cut',
      sourceObjectKey,
      subtitles,
    }) as Promise<{ job: VideoEditJob }>,

  // Uploads straight to storage with the presigned URL — deliberately NOT
  // through apiRequest, which would add an Authorization header the signature
  // does not cover and JSON-encode a binary body.
  uploadVideoFile: async (ticket: VideoUploadTicket, file: File) => {
    const res = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': ticket.contentType },
      body: file,
    });
    if (!res.ok) throw new Error(`Загрузка не удалась: ${res.status}`);
  },

  listVideoJobs: (config: ApiConfig) => apiRequest(config, 'GET', '/api/video-edit-jobs') as Promise<{ jobs: VideoEditJob[] }>,

  getVideoJob: (config: ApiConfig, id: string) => apiRequest(config, 'GET', `/api/video-edit-jobs/${id}`) as Promise<{ job: VideoEditJob }>,

  logout: (config: ApiConfig) => apiRequest(config, 'POST', '/api/auth/logout'),

  approveCaptions: (config: ApiConfig, jobId: string, lines: Array<{ text: string }>) =>
    apiRequest(config, 'PUT', `/api/video-edit-jobs/${jobId}/captions`, { lines }),

  processVideoTick: (config: ApiConfig) => apiRequest(config, 'POST', '/api/video-edit-jobs/process-tick') as Promise<{ advanced: number }>,

  // ---- Push notifications (shared by Modules 5 and 8) ---------------------

  getVapidPublicKey: (config: ApiConfig) => apiRequest(config, 'GET', '/api/push/vapid-public-key') as Promise<{ publicKey: string }>,

  subscribePush: (config: ApiConfig, subscription: PushSubscriptionPayload) =>
    apiRequest(config, 'POST', '/api/push/subscribe', subscription),

  unsubscribePush: (config: ApiConfig, endpoint: string) => apiRequest(config, 'POST', '/api/push/unsubscribe', { endpoint }),

  listNotifications: (config: ApiConfig, unreadOnly = false) =>
    apiRequest(config, 'GET', `/api/notifications${unreadOnly ? '?unreadOnly=true' : ''}`) as Promise<{ notifications: AppNotification[] }>,

  markNotificationRead: (config: ApiConfig, id: string) => apiRequest(config, 'POST', `/api/notifications/${id}/read`),

  markAllNotificationsRead: (config: ApiConfig) => apiRequest(config, 'POST', '/api/notifications/read-all'),
};
