/**
 * 随身陪伴 v1 的跨 TS / Node / Kotlin 契约；只含类型和常量，不含业务实现。
 * Node、Kotlin 在各自信任边界独立校验；TS 类型不是运行时校验器。
 * 除明确标为可选的兼容扩展外，JSON 字段必须存在；未知值用 null，不用省略、空串或猜测。
 * 所有新协议对象拒绝未知字段、重复 JSON 键、非有限数和超界整数；不静默裁剪无效输入。
 * 字符串长度按 Unicode 码点计，字节限制按 UTF-8；所有数组保序，ID 数组不得重复。
 */
export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;
/** UTC Unix 毫秒，非负安全整数；不使用秒或本地日期字符串。 */
export type EpochMs = number;
/** 1..128 个 ASCII 字符，模式 [A-Za-z0-9][A-Za-z0-9._:-]{0,127}，不含个人信息。 */
export type OpaqueId = string;
/** 非负安全整数，generation 从 1 开始，revision 从 0 开始。 */
export type Revision = number;
export type Generation = number;

export const COMPANION_LIMITS = {
  maxJpegBytes: 200 * 1024,
  maxJpegBase64Chars: 273068,
  maxImageLongestEdge: 1024,
  maxVisionRequestBytes: 288 * 1024,
  maxVisionResponseBytes: 32 * 1024,
  maxUpstreamResponseBytes: 64 * 1024,
  maxOutputTokens: 768,
  maxObservations: 6,
  maxEvidencePerObservation: 8,
  maxEvidenceTextChars: 160,
  maxNameChars: 120,
  maxFactTextChars: 120,
  maxRecordTextChars: 2000,
  maxObservationIdsPerRecord: 64,
  maxAmountMinor: 999999999,
  maxAudioBytes: 10 * 1024 * 1024,
  maxMultipartBytes: 10 * 1024 * 1024 + 16 * 1024,
  maxTranscriptionMetadataBytes: 4096,
  maxAudioDurationMs: 60000,
  transcriptionTimeoutMs: 30000,
  maxTranscriptionChars: 6000,
  changePageSize: 100,
} as const;

// ---- 提供商、请求凭据与可信转发 ----
export const PROVIDER_KEY_HEADER = 'X-Jarvis-Provider-Key' as const;
export const PROVIDER_BASE_URLS = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  qwenCn: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  qwenIntl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  qwenUs: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
} as const;
/** 候选不是默认全启用的白名单；后端管理员必须逐一显式启用确切 host。 */
export const PROVIDER_HOST_CANDIDATES = [
  'api.deepseek.com', 'api.openai.com', 'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com',
] as const;
export type QwenBaseUrl = typeof PROVIDER_BASE_URLS.qwenCn
  | typeof PROVIDER_BASE_URLS.qwenIntl | typeof PROVIDER_BASE_URLS.qwenUs;
export type ChatProviderConfig = {
  purpose: 'chat'; preset: 'deepseek'; baseUrl: typeof PROVIDER_BASE_URLS.deepseek;
  /** 非空、至多 128 字符；省配置时使用 DEFAULT_CHAT_PROVIDER。 */
  model: string;
};
export type SttProviderConfig = {
  purpose: 'stt'; preset: 'openai'; baseUrl: typeof PROVIDER_BASE_URLS.openai;
  model: string;
};
export type VisionProviderConfig =
  | { purpose: 'vision'; preset: 'deepseek'; baseUrl: typeof PROVIDER_BASE_URLS.deepseek;
      model: 'deepseek-flash'; thinking: 'disabled'; credentialSource: 'chat' }
  | { purpose: 'vision'; preset: 'qwen'; baseUrl: QwenBaseUrl;
      model: 'qwen3-vl-plus'; thinking: 'disabled'; credentialSource: 'vision' };
export type ProviderConfig = ChatProviderConfig | SttProviderConfig | VisionProviderConfig;
export const DEFAULT_CHAT_PROVIDER: Readonly<ChatProviderConfig> = {
  purpose: 'chat', preset: 'deepseek', baseUrl: PROVIDER_BASE_URLS.deepseek, model: 'deepseek-flash',
};
export const DEFAULT_STT_PROVIDER: Readonly<SttProviderConfig> = {
  purpose: 'stt', preset: 'openai', baseUrl: PROVIDER_BASE_URLS.openai, model: 'whisper-1',
};
/** 仅为明确授权后的选择模板，不代表默认开启视觉或默许复用 Key。 */
export const VISION_PRESETS = {
  deepseek: { purpose: 'vision', preset: 'deepseek', baseUrl: PROVIDER_BASE_URLS.deepseek,
    model: 'deepseek-flash', thinking: 'disabled', credentialSource: 'chat' },
  qwen: { purpose: 'vision', preset: 'qwen', baseUrl: PROVIDER_BASE_URLS.qwenCn,
    model: 'qwen3-vl-plus', thinking: 'disabled', credentialSource: 'vision' },
} as const satisfies Record<string, VisionProviderConfig>;
/** credentialId 指设置中的不透明槽位，不是 Key 摘要；更换 Key 后递增 revision。 */
export type CredentialBinding = { credentialId: OpaqueId; credentialRevision: number };
/** 只能存在于调用栈/请求/当前原生观察会话内存；revision 为正安全整数。 */
export type RequestCredentials = CredentialBinding & { apiKey: string };
export type RequestProvider<P extends ProviderConfig = ProviderConfig> = {
  provider: P; credentials: RequestCredentials;
};
/**
 * 原生端设置模块可在 SecureStore 保存 Key；Web 只用当前页面内存。
 * bridge 只接收前台显式解锁的 RequestCredentials，不自行读取 SecureStore。
 * HTTP 将 apiKey 仅放 PROVIDER_KEY_HEADER，不放 URL/body；credentialBinding 不是密钥，
 * 视觉/聊天把它放 JSON 顶层，STT 放 multipart 的 metadata，具体结构以下方类型为准。
 * 此头不是本应用登录凭证，不得复用 Authorization；后端向上游转换为 Bearer。
 * Key 非空、至多 4096 字符，拒绝 CR/LF/NUL；请求头、音频、图像与上游原始响应一律不记日志。
 * 携带 Key 的客户端/原生请求在发送前拒绝 HTTP，包括回环地址；仅发向用户确认的可信 HTTPS 后端。
 * 后端须验证 TLS 入口；代理只信任管理员配置的 TLS 终止代理，不能盲信转发头。
 * 提供商限固定 baseUrl、精确 host 白名单、443、公网 DNS/IP；拒绝私网/回环、用户信息、
 * query/fragment、自定义路径/端口、重定向及 DNS 重绑定。上游 URL 由受控 baseUrl 加固定路径构造。
 * 两端不跟随重定向。CORS 仅允许可信 UI origin 与所需请求头，不形成任意地址代理。
 * 每次请求独立选凭据；不修改进程环境，不把配置/Key 拼入模型消息、聊天、记忆、记录、事件或错误。
 * STT 必须使用独立配置/凭据，不能自动继承聊天 Key；Qwen 凭据须与所选地域匹配。
 * 所有 provider.model 为非空至多 128 字符；不接受用户提供的任意 HTTP 头或任意上游路径。
 */

// ---- 错误与取消：HTTP 和 bridge 共用脱敏码 ----
export const ERROR_HTTP_STATUS = {
  INVALID_REQUEST: 400, INVALID_SCHEMA: 422, INVALID_AMOUNT: 422, UNSUPPORTED_CURRENCY: 422,
  INSECURE_TRANSPORT: 400, PROVIDER_NOT_ALLOWED: 403, AUTH_REQUIRED: 401, AUTH_FAILED: 401,
  CONSENT_REQUIRED: 403, PERMISSION_DENIED: 403, NOT_FOREGROUND: 409, UNSUPPORTED: 501,
  PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, UPSTREAM_TRUNCATED: 502,
  UPSTREAM_ERROR: 502, NETWORK_UNAVAILABLE: 503, TIMEOUT: 504, CANCELLED: 499,
  STALE_FRAME: 409, STALE_GENERATION: 409, LIMIT_REACHED: 429, NO_USABLE_PREVIEW: 422,
  ALREADY_RUNNING: 409, STORAGE_FAILED: 500, NOT_FOUND: 404, CONFLICT: 409,
  OP_ID_CONFLICT: 409, INVALID_REVISION: 409, SNAPSHOT_REQUIRED: 409, CLOCK_UNCERTAIN: 409,
} as const;
export type CompanionErrorCode = keyof typeof ERROR_HTTP_STATUS;
export type CompanionError = {
  code: CompanionErrorCode;
  /** 固定脱敏用户提示，不含 Key、URL、屏幕原文、文件路径或上游响应。 */
  message: string;
  retryable: boolean;
};
export type ErrorResponse = { schemaVersion: SchemaVersion; error: CompanionError };
export type BridgeResult<T> =
  | { schemaVersion: SchemaVersion; ok: true; value: T }
  | { schemaVersion: SchemaVersion; ok: false; error: CompanionError };
/**
 * HTTP 非 2xx 返回 ErrorResponse；取消若连接已断不保证收到 499，由调用方合成本地 CANCELLED。
 * AbortSignal 只留 JS options，不序列化；关闭连接即取消后端与上游，无独立取消端点。
 * 不自动重试收费请求，不为修 JSON 再调模型；取消不能追回已上传数据或保证免费。
 * bridge 的可预期失败 resolve ok:false；adapter 将桥接异常映射为脱敏结果，不冒充成功。
 */

// ---- 现有聊天的兼容追加项：不替换 messages / health 或 NDJSON 事件 ----
export const MEMORY_LIMITS = {
  recentMessages: 20, maxMessageChars: 6000, maxContextChars: 16000,
  confirmedPreferences: 20, maxPreferenceChars: 240,
} as const;
export type ConfirmedPreference = {
  id: OpaqueId; text: string; sourceMessageId: OpaqueId;
  createdAt: EpochMs; confirmedAt: EpochMs; status: 'confirmed';
};
export type MemoryRequestContext = {
  schemaVersion: SchemaVersion;
  /** 最近至多 20 条消息 + 下列偏好的 text 合计至多 16000 码点；不含健康快照。 */
  limits: { recentMessages: number; maxContextChars: number; confirmedPreferences: number };
  preferences: ConfirmedPreference[];
};
/** 上限只能收紧，不得放宽；撤销/清空的偏好在下一请求前移除，不上传全量生活库。 */
export type AssistantOptionsExtension = {
  requestProvider?: RequestProvider<ChatProviderConfig>;
  memory?: MemoryRequestContext;
};
/** 集成者将 StreamOptions 与此类型求交，原 onReply / signal 及三参数签名保持不变。 */
export type AssistantWireExtension = {
  schemaVersion?: SchemaVersion;
  provider?: ChatProviderConfig;
  credentialBinding?: CredentialBinding;
  memory?: MemoryRequestContext;
};
/**
 * requestProvider 存在时 schemaVersion/provider/credentialBinding + Key 头必须配齐；缺 Key 不回退环境 Key。
 * memory 独立可选，但有任一扩展必须带 schemaVersion=1。完全无扩展的旧请求可沿用服务端配置。
 * 服务端先单独校验/提取凭据，仅把白名单 memory 数据注入上下文，凭据不可进入 validateRequest 输出。
 * 保留 /v1/assistant/stream 和 /v1/recovery/stream 的 start/reply/complete/error NDJSON。
 * 流开始前可返回 ErrorResponse；开始后仍用 {type:'error',message,code?}，保留旧解析器兼容。
 */

// ---- 视觉：唯一 HTTP 格式为 application/json + 无前缀的 Base64 JPEG ----
export const VISION_ENDPOINT = '/v1/vision/observations' as const;
export type ObservationTaskMode = 'food' | 'expense' | 'mixed';
export type FrameMetadata = {
  sessionId: OpaqueId; generation: Generation; frameId: OpaqueId;
  capturedAt: EpochMs; taskMode: ObservationTaskMode;
};
export type VisionObservationRequest = {
  schemaVersion: SchemaVersion;
  provider: VisionProviderConfig;
  credentialBinding: CredentialBinding;
  metadata: FrameMetadata;
  image: { mimeType: 'image/jpeg'; width: number; height: number; base64: string };
};
/**
 * 不接受 multipart、URL、data: URI 或其他图片格式；Base64 必须为规范带 padding 的 RFC4648。
 * image 宽高为 1..1024 的整数，以实际 JPEG 解码结果为准；拒绝伪造宽高/畸形数据/解压炸弹。
 * 限 decoded JPEG 204800 字节、encoded 273068 字符、完整 JSON 294912 字节；读取时即限流限长。
 * 帧在发送、收到结果、事务提交三个节点都须满足当前 session/generation 且本地单调帧龄不超过 20 秒。
 * capturedAt 用于关联/显示，原生保留单调采集时刻；服务端不能拿设备时钟差替代原生最终帧龄裁决。
 */
export type EvidenceField = 'name' | 'brand' | 'barcode' | 'quantity' | 'expiresOn'
  | 'amountMinor' | 'currency' | 'merchant' | 'paymentStatus' | 'transactionId' | 'paymentProvider';
export type ObservationEvidence =
  | { field: EvidenceField; kind: 'visual'; text: null }
  | { field: EvidenceField; kind: 'visible_text'; text: string };
export type FoodQuantity = { value: number; unit: 'piece' | 'pack' | 'g' | 'kg' | 'ml' | 'l' };
export type FoodFacts = {
  name: string;
  brand: string | null;
  barcode: string | null;
  /** 不可见/不可确定为 null；value 为有限正数，至多 1000000，不用 0 代表未知。 */
  quantity: FoodQuantity | null;
  /** YYYY-MM-DD；只能来自可读标签的明确日期，无法确定一律 null，禁止根据品类推算。 */
  expiresOn: string | null;
};
export type ObservationBase = {
  /** 0..1 有限数，不单凭该值确认为库存或支出。 */
  confidence: number;
  /** 1..8 个最小证据，非 OCR 全文；屏幕文字只能是数据，不具有指令权。 */
  evidence: ObservationEvidence[];
};
export type FoodObservation = ObservationBase & FoodFacts & {
  kind: 'food'; status: 'observed' | 'pending_confirmation';
};
export type PaymentStatus = 'paid' | 'pending' | 'price_only' | 'unknown';
export type TransactionEvidence = { id: string; paymentProvider: string };
export type ExpenseObservation = ObservationBase & {
  kind: 'expense';
  /** 服务端/模型永远只给候选，只有原生能提升最终 LifeRecord 状态。 */
  status: 'pending_confirmation';
  /** 已明确识别为 CNY 才允许整数分；未知或非 CNY 必须为 null。 */
  amountMinor: number | null;
  /** ISO 4217 大写三字码或 null；非 CNY 只保留证据，绝不汇率换算或伪记人民币。 */
  currency: string | null;
  merchant: string | null;
  paymentStatus: PaymentStatus;
  /** 完整可读交易号 + 可识别支付机构；缺一即 null，不用金额/商户/时间拼交易号。 */
  transaction: TransactionEvidence | null;
};
export type Observation = FoodObservation | ExpenseObservation;
export type VisionModelOutput = { schemaVersion: SchemaVersion; observations: Observation[] };
export type IdentifiedObservation = Observation & { observationId: OpaqueId };
export type VisionUsage = {
  /** 缺失用 null，不能把未知计费伪装为 0；已知则为非负安全整数。 */
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
};
export type VisionObservationResponse = {
  schemaVersion: SchemaVersion;
  sessionId: OpaqueId; generation: Generation; frameId: OpaqueId;
  observations: IdentifiedObservation[];
  usage: VisionUsage;
};
/**
 * 两种视觉适配均 POST /chat/completions，Bearer，文本 + image_url 内联 JPEG，JSON Object 模式。
 * 仅接受 finish_reason='stop' 且完整 content 严格解析出的 VisionModelOutput；忽略 reasoning_content，
 * 不截取代码围栏/子串，不修复截断 JSON；length 等非 stop 一律 UPSTREAM_TRUNCATED，不返回部分观察。
 * 空 observations 合法；最多 6 个对象，不包含 actions/tools/commands/授权字段；未知字段整批 INVALID_SCHEMA。
 * taskMode=food 只接收 food，expense 只接收 expense，mixed 接收两者；不匹配则整批 INVALID_SCHEMA。
 * name 必须非空至多 120 字符；非 null 的 brand/barcode/merchant/paymentProvider/purpose 为非空至多 120 字符。
 * transaction.id 为非空至多 128 字符；数量、日期、钱和证据须类型匹配，禁止字符串转数值或猜测缺失字段。
 * amountMinor 非 null 时不为正安全整数或超过上限返回 INVALID_AMOUNT；非 CNY 却给数字返回 UNSUPPORTED_CURRENCY。
 * expiresOn 必须是真实日历日期；visible_text 必须非空且至多 160 字符；不相关证据不能支撑自动确认。
 * observationId 由后端生成：'obs_' + SHA-256(UTF-8(JSON.stringify([sessionId,generation,frameId,index]))) 小写 hex。
 * 模型不生成 ID；相同 frame/index 得同一 ID。原生先校验完整响应，再在同一事务中裁决，整批失败整批不写。
 * food 必须有 name 的可见证据；quantity/brand/barcode/expiresOn 非 null 时有对应证据；日期需 visible_text。
 * food 低于 0.8 或 status=pending_confirmation 均待确认；其余仅 observed，不自动声称已证实库存。
 * 相同规范名称 + 可读品牌/条码 + 本地冰箱上下文匹配只更新 lastSeenAt/证据，不累加数量；没看到不删除。
 * expense 自动 confirmed 的全部必要条件：taskMode=expense/mixed、用户独立 autoConfirmExpenses=true、
 * confidence>=0.8、paymentStatus=paid、CNY、正整数分、非空 merchant、完整 transaction，且金额、币种、
 * 商户、支付成功、交易号、支付机构均有相符的 visible_text 证据；原生仍可因证据不可靠保持待确认。
 * 非 CNY 或缺任一条件只能待确认；错误钱值直接拒绝，不四舍五入、不猜单位；手工确认外币返回 UNSUPPORTED_CURRENCY。
 * 已确认屏幕支出以 (paymentProvider, transaction.id) 精确唯一；金额/商户/时间相同不构成永久唯一键。
 * 所有记录和事件禁止含原始图片、完整 OCR/模型回复、凭据或可执行动作。
 */
export const OBSERVATION_CONFIDENCE_FLOOR = 0.8 as const;

// ---- 语音转写：只此一个 multipart 入口，无后台录音 ----
export const TRANSCRIPTION_ENDPOINT = '/voice/transcriptions' as const;
export const TRANSCRIPTION_PARTS = { file: 'file', metadata: 'metadata' } as const;
export const TRANSCRIPTION_MEDIA = [
  { mimeType: 'audio/mp4', extensions: ['m4a', 'mp4'] },
  { mimeType: 'audio/m4a', extensions: ['m4a'] },
  { mimeType: 'audio/x-m4a', extensions: ['m4a'] },
  { mimeType: 'audio/mpeg', extensions: ['mp3', 'mpeg', 'mpga'] },
  { mimeType: 'audio/wav', extensions: ['wav'] },
  { mimeType: 'audio/x-wav', extensions: ['wav'] },
  { mimeType: 'audio/webm', extensions: ['webm'] },
] as const;
export type TranscriptionMetadata = {
  schemaVersion: SchemaVersion; requestId: OpaqueId;
  provider: SttProviderConfig; credentialBinding: CredentialBinding;
  durationMs: number;
  /** ISO 639-1 小写两字码，自动识别为 null。 */
  language: string | null;
};
export type TranscriptionResponse = {
  schemaVersion: SchemaVersion; requestId: OpaqueId; text: string;
};
/**
 * Content-Type: multipart/form-data; boundary 由 HTTP 实现生成。恰好两个 part，不接受重复/额外 part：
 * file：二进制，原始录音 MIME（可带 codecs 参数）及匹配的真实扩展名，filename 无路径/个人信息；
 * metadata：application/json 的完整 TranscriptionMetadata，至多 4096 字节，无 BOM/额外字段。
 * apiKey 仍只在 X-Jarvis-Provider-Key；multipart 内没有 key、独立 model/prompt 或本地文件 URI 字段。
 * durationMs 为 1..60000 整数，file 非空且至多 10MiB，完整 multipart 至多 10MiB+16KiB。
 * 服务端核对容器/MIME/扩展名及可解析时长，不能仅信客户端声明；不支持的格式明确拒绝，不伪装重命名。
 * 上游固定 /audio/transcriptions：file 原样、model=provider.model、response_format=json；非 null language 才传。
 * 一次用户输入至多一次 STT + 一次原有聊天请求；转写不自动发送聊天，先供用户检查文本。
 * AbortSignal 取消上传/转写；30 秒超时、页面离开/请求代次失效时丢弃晚到文本，不继续聊天/TTS。
 * 返回 text 为非空至多 6000 字符，否则 INVALID_SCHEMA；错误使用 ErrorResponse，不返回上游正文。
 */

// ---- 原生观察配置：桌面陪伴与观察互不隐式启动 ----
export const OBSERVATION_DEFAULTS = {
  sampleHz: 1, hashSampleEdge: 64, hashBits: 64, stableSamples: 2, dHashThreshold: 6,
  minRequestIntervalMs: 8000, requestTimeoutMs: 12000, maxFrameAgeMs: 20000,
  sessionDurationMs: 30 * 60 * 1000, maxSessionAttempts: 40, maxDailyAttempts: 100,
  maxConsecutiveFailures: 3, maxInFlight: 1, maxPendingFrames: 1,
} as const;
export const OBSERVATION_BUDGET_MAX = {
  sessionDurationMs: 60 * 60 * 1000, maxSessionAttempts: 120, maxDailyAttempts: 500,
} as const;
export const COMPANION_DEFAULTS = {
  companionEnabled: false, observationEnabled: false, autoConfirmExpenses: false,
} as const;
export type ObservationBudget = {
  sessionDurationMs: number; maxSessionAttempts: number; maxDailyAttempts: number;
};
export type CloudVisionConsent = {
  accepted: true; acceptedAt: EpochMs;
  provider: VisionProviderConfig;
  /** 不带路径/query 的 HTTPS 后端 origin，与 config.backendOrigin 精确相同。 */
  backendOrigin: string;
  /** 仅 DeepSeek credentialSource=chat 时必须 true；Qwen 时必须 false。 */
  reuseChatKeyAccepted: boolean;
};
export type ObservationConfig = {
  schemaVersion: SchemaVersion; backendOrigin: string; provider: VisionProviderConfig;
  credentialBinding: CredentialBinding;
  taskMode: ObservationTaskMode;
  cloudConsent: CloudVisionConsent;
  autoConfirmExpenses: boolean;
  /** 自动入账默认 false；开启时必须有独立确认时间，关闭为 null。 */
  autoConfirmExpensesAcceptedAt: EpochMs | null;
  /** 默认预算可主动调整；非默认值必须有用户确认时间，禁止模型修改。 */
  budget: ObservationBudget; budgetAcceptedAt: EpochMs | null;
  /** 本地冰箱上下文 ID，不发送给模型；与当前用户授权一致。 */
  foodContextId: OpaqueId | null;
};
export type ObservationSession = {
  sessionId: OpaqueId; generation: Generation; startedAt: EpochMs;
};
export type ObservationStopReason = 'user' | 'paused' | 'stop_all' | 'locked'
  | 'projection_revoked' | 'permission_revoked' | 'notification_hidden'
  | 'credentials_changed' | 'credentials_cleared' | 'service_recreated'
  | 'session_limit' | 'daily_limit' | 'consecutive_failures' | 'no_usable_preview'
  | 'life_cleared' | 'clock_uncertain';
export type ObservationCounters = {
  sessionAttempts: number; dailyAttempts: number; consecutiveFailures: number;
  sessionLimit: number; dailyLimit: number; sessionEndsAt: EpochMs | null;
  /** UTC YYYY-MM-DD 计费计数日；时钟回拨不重置，重建不得重置持久化当日尝试数。 */
  dailyBucket: string;
};
/**
 * 预算为正安全整数且不可无限；上限 60 分钟/120 次会话/500 次每日，默认值见 OBSERVATION_DEFAULTS。
 * 未显式确认调整时只能使用默认预算。每日计数以 UTC 日为界，异常时间前跳/回拨停止并提示。
 * 本地先遮罩悬浮区域并排除变化检测：64x64 灰度预采样，再缩到 9x8，横向比较相邻亮度形成 64-bit dHash。
 * 相邻样本 Hamming <6 连续两样本为稳定；相对上次已分析画面 >=6 为变化；首个稳定帧不等 8 秒。
 * 后续按尝试启动时刻至少间隔 8 秒；最多一个在途/一个最新候选，不保存旧图队列，断网丢弃图像。
 * 发送前原子持久化尝试次数，失败也计费预算；达到任何上限或连续三次失败只停观察，保留陪伴。
 * 单个无效响应/网络/保存失败各计一次失败；无对象的合法响应不是失败；不以重试绕过静止画面去重。
 * startObservation 必须在可见前台，经独立云许可和新一次系统共享授权；systemGranted 布尔不能由 JS 伪造。
 * cloudConsent.provider/backendOrigin 必须与 config 精确匹配，变更供应商/后端须重新告知授权。
 * 原生系统授权 Intent/token 不跨 bridge、事件或数据库，不复用；优先单 App 共享，黑屏明确报无可用预览。
 * generation 持久化单调递增，sessionId 每次随机新建；已有活动/启动中的观察返回 ALREADY_RUNNING。
 * stop 先串行失效 generation，再取消请求/释放投影与图像资源/清理凭据；提交事务前再次核对代际和帧龄。
 * 已先提交的事务不因 stop 撤销；失效线性化点之后的晚到结果不得产生记录。
 * Key 更改/清除先停止绑定该 Key 的观察（含复用聊天 Key），随后替换/删除 Key；重新开启需新授权。
 * 重建、锁屏、撤销、暂停均不自动恢复观察/录音/凭据；暂停就是停止，续开需要新 session。
 */

// ---- 唯一权威生活记录：Android 原生 SQLite，RN 只通过 bridge ----
export type LifeSource =
  | ({ kind: 'screen_observation' } & FrameMetadata)
  | { kind: 'manual_text' | 'manual_voice' | 'manual_action' | 'foreground_location' };
export type RecordStatus = 'observed' | 'pending_confirmation' | 'confirmed' | 'revoked';
export type LifeRecordBase = {
  schemaVersion: SchemaVersion; id: OpaqueId; revision: Revision;
  text: string; source: LifeSource; status: RecordStatus;
  createdAt: EpochMs; updatedAt: EpochMs; lastSeenAt: EpochMs | null;
  /** 最近至多 64 个去重 ID，完整防重由原生单独的唯一索引保证，不靠此展示数组。 */
  observationIds: OpaqueId[];
};
export type FoodLifeRecord = LifeRecordBase & FoodFacts & {
  kind: 'foodObservation'; foodContextId: OpaqueId | null; evidence: ObservationEvidence[];
};
export type ExpenseLifeRecord = LifeRecordBase & {
  kind: 'expense'; status: 'pending_confirmation' | 'confirmed' | 'revoked';
  amountMinor: number | null; currency: string | null; merchant: string | null;
  purpose: string | null; paymentStatus: PaymentStatus;
  transaction: TransactionEvidence | null; evidence: ObservationEvidence[];
};
export type PomodoroClock = {
  bootId: OpaqueId; anchorMonotonicMs: number; anchorWallTimeMs: EpochMs;
  elapsedActiveMs: number; accumulatedPausedMs: number;
};
export type PomodoroLifeRecord = LifeRecordBase & {
  kind: 'pomodoro'; status: 'confirmed' | 'revoked';
  phase: 'focus' | 'break'; durationMs: number;
  timerState: 'running' | 'paused' | 'finished' | 'interrupted';
  startedAt: EpochMs; pausedAt: EpochMs | null; finishedAt: EpochMs | null;
  finishReason: 'completed' | 'user' | null;
  clock: PomodoroClock; clockIntegrity: 'verified' | 'needs_review';
};
export type NoteLifeRecord = LifeRecordBase & { kind: 'note'; status: 'confirmed' | 'revoked' };
export type LocationLifeRecord = LifeRecordBase & {
  kind: 'location'; status: 'confirmed' | 'revoked';
  latitude: number; longitude: number; accuracyMeters: number | null;
};
export type LifeRecord = FoodLifeRecord | ExpenseLifeRecord | PomodoroLifeRecord | NoteLifeRecord | LocationLifeRecord;
export type LifeRecordKind = LifeRecord['kind'];
export const POMODORO_DEFAULTS = { focusDurationMs: 25 * 60 * 1000, breakDurationMs: 5 * 60 * 1000 } as const;
/**
 * confirmed 支出必须为 CNY + 1..maxAmountMinor 的整数分；手工完整输入不需要屏幕交易号。
 * food observed 不等于确认库存；视觉 lastSeenAt=最后有效 capturedAt，其他来源可为 null。
 * 所有 createdAt/updatedAt 由 Repository 产生，更新保留原 id/createdAt/source，记录 revision 为本次提交序号。
 * 同时最多一个 running/paused 番茄钟；durationMs 为 1 秒..3 小时，elapsed/paused 时间均为非负安全整数。
 * clock 是持久化锚点：running 的有效耗时=elapsedActiveMs+当前单调时钟-anchorMonotonicMs，paused 不增长。
 * 同一开机周期只用单调时钟，跨重启校验墙钟；无法证明连续性标 interrupted/needs_review，不伪造完成。
 * resume 对 needs_review 返回 CLOCK_UNCERTAIN；用户可 finish 后重开。计时恢复不恢复观察/录音。
 * 通知延迟不改变真实计时结果；删除/撤销活动番茄钟须同事务停止计时及撤销通知。
 */

// ---- 所有 UI 写入都走命令；视觉提交是原生内部路径，JS 不能伪造 screen_observation ----
export type ManualOrigin = 'manual_text' | 'manual_voice' | 'manual_action';
export type ManualExpenseInput = {
  text: string; amountMinor: number; currency: 'CNY'; purpose: string; merchant: string | null;
};
export type RecordTarget = { recordId: OpaqueId; expectedRevision: Revision };
export type CommandEnvelope<K extends string, P> = {
  schemaVersion: SchemaVersion; opId: OpaqueId; kind: K; payload: P; observationIds: OpaqueId[];
};
export type LifeCommand =
  | CommandEnvelope<'note.create', { text: string; source: ManualOrigin }>
  | CommandEnvelope<'expense.create', ManualExpenseInput & { source: 'manual_text' | 'manual_voice' }>
  | CommandEnvelope<'location.create', {
      text: string; latitude: number; longitude: number; accuracyMeters: number | null;
      capturedAt: EpochMs; userConfirmed: true;
    }>
  | CommandEnvelope<'record.confirm', RecordTarget & {
      userConfirmed: true;
      facts: ({ kind: 'foodObservation' } & FoodFacts)
        | ({ kind: 'expense' } & ManualExpenseInput);
    }>
  | CommandEnvelope<'record.revoke', RecordTarget & { userConfirmed: true }>
  | CommandEnvelope<'record.delete', RecordTarget & { userConfirmed: true }>
  | CommandEnvelope<'life.clear', { scope: 'all'; expectedRevision: Revision; userConfirmed: true }>
  | CommandEnvelope<'pomodoro.start', {
      text: string; phase: 'focus' | 'break'; durationMs: number; source: ManualOrigin;
    }>
  | CommandEnvelope<'pomodoro.pause', RecordTarget>
  | CommandEnvelope<'pomodoro.resume', RecordTarget>
  | CommandEnvelope<'pomodoro.finish', RecordTarget>;
export type CommandReceipt = {
  schemaVersion: SchemaVersion; opId: OpaqueId; eventId: OpaqueId; revision: Revision;
  recordIds: OpaqueId[]; committedAt: EpochMs; replayed: boolean;
};
/**
 * source 为实际输入渠道，不能来自模型自称；屏幕文字不得构造任何命令或自动点击授权。
 * 新建手工记录及 life.clear 的 observationIds 必须 []；其余命令只能引用该记录已有的 ID，不可添造证据。
 * expense.create 的 purpose/text 必须非空；手工支出 paymentStatus=paid、transaction=null、evidence=[]。
 * 位置记录 source=foreground_location；手工记录的证据与 observationIds 为空，不能伪造视觉来源。
 * record.confirm 仅适用于食材/支出候选或 observed；facts.kind 必须匹配，不改写原始观察证据。
 * record.revoke 改为 revoked，不等于支付退款/库存物理移除；恢复已撤销记录需新的明确输入，不能由观察复活。
 * record.delete 物理移除记录并生成不含个人内容的删除事件；life.clear 原子清除所有生活数据，不清聊天/偏好。
 * life.clear 先失效观察会话、停止计时，再清库；用户需重新开启观察，防止晚到结果自动回填。
 * expectedRevision 是记录当前 revision（clear 为库当前 revision），不匹配返回 CONFLICT，无写入。
 * 命令 opId 对应数据库唯一 operationId；先查幂等收据，再查 expectedRevision，重投不会因旧 revision 再写。
 * 同 opId 且相同规范 payload 返回原 eventId/revision/recordIds，replayed=true；不同内容返回 OP_ID_CONFLICT。
 * 幂等哈希包含 kind/payload/observationIds（键排序，数组保序）；严禁把凭据加入操作哈希或存储。
 * 删除/清空后保留仅含不透明 ID/摘要/序号的防重收据与墓碑，避免旧命令/旧交易重新入账，不保留原始正文。
 * location 仅前台一次性授权，latitude [-90,90]、longitude [-180,180]，精度有限非负或 null，不后台跟踪。
 */

// ---- SQLite 事务 + outbox：持久化事实与通知消费分离 ----
export type LifeChange = {
  schemaVersion: SchemaVersion; eventId: OpaqueId; opId: OpaqueId;
  revision: Revision; occurredAt: EpochMs;
  change: { kind: 'upsert'; record: LifeRecord }
    | { kind: 'delete'; recordId: OpaqueId }
    | { kind: 'clear' };
};
export type LifeChangePage = {
  schemaVersion: SchemaVersion; afterRevision: Revision;
  throughRevision: Revision; currentRevision: Revision;
  changes: LifeChange[]; hasMore: boolean;
};
export type LifeSnapshot = {
  schemaVersion: SchemaVersion; authority: 'native_sqlite' | 'local_fallback';
  revision: Revision; records: LifeRecord[];
  /** 供 JS 重建后恢复服务状态/用量；与事件同形，不含配置或凭据。 */
  companion: CompanionState; observation: ObservationState;
};
export type AckReceipt = { schemaVersion: SchemaVersion; ackedRevision: Revision };
/**
 * 一个串行 Repository 事务同时写记录、operationId 收据、eventId 与 outbox；提交成功后才能提示“已记录”。
 * 每个事件 revision 全库严格递增；不复用/倒退，clear 不归零。一个命令产生一个事件；失败不产生收据/事件。
 * 原生视觉一帧整批原子提交，每个变化记录一个事件/operationId；重复 observationId 不重复入账。
 * 原生内部 opId 由观察 ID 派生，保留 internal. 前缀；公开 bridge 拒绝该前缀，防止 JS 冒充视觉写者。
 * readChanges(afterRevision) 返回严格大于参数的升序事件，最多 100 条；throughRevision 为末条或原参数。
 * 参数超过当前 revision 为 INVALID_REVISION，早于已压缩/清空边界为 SNAPSHOT_REQUIRED，不能悄悄漏事件。
 * getSnapshot 在同一读事务取得 revision 和记录；收到后用它整体替换 UI 投影，续读该 revision 之后的事件。
 * 其中 companion/observation 是串行状态机的当前快照，生命周期事件不占用生活库 revision。
 * ackChanges(revision) 仅推进单一 UI 消费者已应用游标，可 ACK 已安装快照的 revision；不得大于当前 revision。
 * 重复/更小 ACK 幂等返回当前 ackedRevision；ACK 不调用 submitLifeCommand，不写生活记录，不生成新 revision。
 * outbox 可在 ACK 后压缩；清空时删除旧 payload，只保留无内容收据并抬高快照恢复边界。
 * 事件至少一次投递；UI 用 eventId/revision 防重，只更新非权威投影，不再存一份 Android 权威账本。
 * AsyncStorage 仅继续存聊天/偏好；Android 库禁云备份、禁 mock 回填/replace:true 全量覆盖与默认上云。
 */

// ---- 人物状态与能力降级 ----
export const CHARACTER_STATES = ['idle', 'listening', 'thinking', 'speaking', 'observing', 'error'] as const;
export type CharacterState = typeof CHARACTER_STATES[number];
export type UnsupportedReason = 'not_android' | 'expo_go' | 'native_module_missing';
export type CompanionCapabilities = {
  schemaVersion: SchemaVersion;
  runtime: 'android_native' | 'web' | 'ios' | 'expo_go';
  authority: 'native_sqlite' | 'local_fallback';
  systemOverlay: boolean; screenObservation: boolean; backgroundTimer: boolean;
  lifeCommands: boolean; unsupportedReasons: UnsupportedReason[];
};
export type CompanionConfig = { schemaVersion: SchemaVersion; reduceMotion: boolean };
export type CompanionState = {
  running: boolean; characterState: CharacterState;
  /** 因应用前台/其他应用限制而暂时不可见，不等于服务已停止。 */
  overlayVisible: boolean;
};
export type ObservationState = {
  state: 'stopped' | 'starting' | 'observing';
  session: ObservationSession | null;
  /** 当前分配/失效后的代际，无活动会话时也保留，不允许旧结果复用。 */
  generation: Generation;
  stopReason: ObservationStopReason | null;
  counters: ObservationCounters;
  lastObservationAt: EpochMs | null;
  lastRecordId: OpaqueId | null;
};
export type StopObservationReceipt = {
  stoppedSessionId: OpaqueId | null; invalidatedGeneration: Generation | null;
  currentGeneration: Generation; reason: ObservationStopReason;
};
/**
 * listening=实际录音中，thinking=请求在途，speaking=真实 TTS 播放中，observing=原生观察会话运行。
 * 前台冲突优先级 error > listening > speaking > thinking > observing > idle；关闭面板不伪造在录音。
 * 现有 DragonCompanion 只有 size/active/reduceMotion/pulse，无 status prop；集成层映射状态到反馈，
 * active 仍为可见/动画门控，不用它表示观察服务是否存活；reduceMotion/离屏/后台必须停无用动画。
 * Web/iOS/Expo Go 的 overlay/observation/backgroundTimer=false，相关 start 返回 UNSUPPORTED，
 * 只提供前台 local_fallback 记录/计时；不把 Modal 当系统悬浮窗，不与 Android SQLite 同步为双写权威。
 */

// ---- 唯一原生模块与事件名；所有方法统一 Promise<BridgeResult<T>> ----
export const NATIVE_MODULE_NAME = 'JarvisCompanion' as const;
export const NATIVE_EVENT_NAMES = {
  companionState: 'onCompanionState', observationState: 'onObservationState',
  lifeChanges: 'onLifeChanges', error: 'onCompanionError',
} as const;
export type NativeEventEnvelope = { schemaVersion: SchemaVersion; emittedAt: EpochMs };
export type NativeEventMap = {
  onCompanionState: NativeEventEnvelope & { state: CompanionState };
  onObservationState: NativeEventEnvelope & { state: ObservationState };
  /** 只唤醒读 outbox；即使重复/丢失也不影响持久化，不能凭本事件宣称新增了一笔。 */
  onLifeChanges: NativeEventEnvelope & { revision: Revision; eventId: OpaqueId };
  onCompanionError: NativeEventEnvelope & {
    scope: 'companion' | 'observation' | 'life' | 'timer';
    sessionId: OpaqueId | null; generation: Generation | null; error: CompanionError;
  };
};
export type NativeEventName = keyof NativeEventMap;
export interface JarvisCompanionBridge {
  getCapabilities(): Promise<BridgeResult<CompanionCapabilities>>;
  startCompanion(config: CompanionConfig): Promise<BridgeResult<CompanionState>>;
  /** 只停止陪伴；一键全停由集成者先 stopObservation('stop_all')，再 stopCompanion('stop_all')。 */
  stopCompanion(reason: 'user' | 'stop_all'): Promise<BridgeResult<CompanionState>>;
  startObservation(config: ObservationConfig, credentials: RequestCredentials): Promise<BridgeResult<ObservationSession>>;
  stopObservation(reason: ObservationStopReason): Promise<BridgeResult<StopObservationReceipt>>;
  submitLifeCommand(command: LifeCommand): Promise<BridgeResult<CommandReceipt>>;
  readChanges(afterRevision: Revision): Promise<BridgeResult<LifeChangePage>>;
  ackChanges(revision: Revision): Promise<BridgeResult<AckReceipt>>;
  getSnapshot(): Promise<BridgeResult<LifeSnapshot>>;
}
/**
 * getCapabilities 不请求权限；startCompanion 只处理陪伴权限/可见通知，不能隐式启动看屏。
 * startObservation 不要求先开启陪伴，但要求自身通知可见、系统和云授权齐备。
 * credentials 的 credentialId/credentialRevision 必须与 config.credentialBinding 匹配，成功 value 返回 sessionId/generation。
 * stopCompanion 幂等且不停止独立观察；stopObservation 幂等，空闲重复 stop 不再分配代际。
 * 初装 generation=1，无会话时返回停止态；新开/失效时递增，并在同一串行状态机内发布事件。
 * 生命周期监听由平台 adapter 包装 NativeEventMap；本契约不导入 Expo/RN 或定义额外事件 emitter 实现。
 * 原生观察/SQLite/反馈不能依赖 RN 事件订阅或 JS 存活；事件只作提示，恢复以 snapshot + outbox 为准。
 */
