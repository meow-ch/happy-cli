import { z } from 'zod'
import { UsageSchema } from '@/claude/types'

/**
 * Legacy permission mode type - includes both Claude and Codex preset modes.
 * Must match MessageMetaSchema.permissionMode enum values
 *
 * Claude modes: default, acceptEdits, auto, bypassPermissions, dontAsk, plan
 * Codex modes: read-only, safe-yolo, yolo
 *
 * When calling Claude SDK, Codex modes are mapped at the SDK boundary:
 * - yolo → bypassPermissions
 * - safe-yolo → default
 * - read-only → default
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk'
export type PermissionMode = ClaudePermissionMode | 'plan' | 'read-only' | 'safe-yolo' | 'yolo'
export type PermissionPreset = 'ask' | 'auto_edits' | 'full_access' | 'read_only'
export type RuntimeMode = 'default' | 'plan'
export type RuntimeAccessMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexCollaborationMode = 'default' | 'plan'
export type CodexPermissionProfile = ':read-only' | ':workspace' | ':danger-full-access' | (string & {})
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

/**
 * Base message content structure for encrypted messages
 */
export const SessionMessageContentSchema = z.object({
  c: z.string(), // Base64 encoded encrypted content
  t: z.literal('encrypted')
})

export type SessionMessageContent = z.infer<typeof SessionMessageContentSchema>

/**
 * Update body for new messages
 */
export const UpdateBodySchema = z.object({
  message: z.object({
    id: z.string(),
    seq: z.number(),
    content: SessionMessageContentSchema
  }),
  sid: z.string(), // Session ID
  t: z.literal('new-message')
})

export type UpdateBody = z.infer<typeof UpdateBodySchema>

export const UpdateSessionBodySchema = z.object({
  t: z.literal('update-session'),
  sid: z.string(),
  metadata: z.object({
    version: z.number(),
    value: z.string()
  }).nullish(),
  agentState: z.object({
    version: z.number(),
    value: z.string()
  }).nullish()
})

export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>

/**
 * Update body for machine updates
 */
export const UpdateMachineBodySchema = z.object({
  t: z.literal('update-machine'),
  machineId: z.string(),
  metadata: z.object({
    version: z.number(),
    value: z.string()
  }).nullish(),
  daemonState: z.object({
    version: z.number(),
    value: z.string()
  }).nullish()
})

export type UpdateMachineBody = z.infer<typeof UpdateMachineBodySchema>

/**
 * Update event from server
 */
export const UpdateSchema = z.object({
  id: z.string(),
  seq: z.number(),
  body: z.union([
    UpdateBodySchema,
    UpdateSessionBodySchema,
    UpdateMachineBodySchema,
  ]),
  createdAt: z.number()
})

export type Update = z.infer<typeof UpdateSchema>

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data: { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean }) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  message: (data: { sid: string, message: any }) => void
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
  }) => void
  'session-end': (data: { sid: string, time: number }) => void,
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void,
  'update-state': (data: { sid: string, expectedVersion: number, agentState: string | null }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    agentState: string | null
  } | {
    result: 'success',
    version: number,
    agentState: string | null
  }) => void) => void,
  'ping': (callback: () => void) => void
  'rpc-register': (data: { method: string }) => void
  'rpc-unregister': (data: { method: string }) => void
  'rpc-call': (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
  'usage-report': (data: {
    key: string
    sessionId: string
    tokens: {
      total: number
      [key: string]: number
    }
    cost: {
      total: number
      [key: string]: number
    }
  }) => void
}

/**
 * Session information
 */
export type Session = {
  id: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
}

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string(),
  claudeCodeVersion: z.string().optional(),
  claudeCodeLatestVersion: z.string().optional(),
  claudeCodeUpdateCommand: z.string().optional(),
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

/**
 * Session message from API
 */
export const SessionMessageSchema = z.object({
  content: SessionMessageContentSchema,
  createdAt: z.number(),
  id: z.string(),
  seq: z.number(),
  updatedAt: z.number()
})

export type SessionMessage = z.infer<typeof SessionMessageSchema>

/**
 * Message metadata schema
 */
export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(), // Source identifier
  permissionPreset: z.enum(['ask', 'auto_edits', 'full_access', 'read_only']).nullable().optional(), // Provider-neutral permission preset (null = reset)
  permissionMode: z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(), // Legacy cross-provider mode for this message
  mode: z.enum(['default', 'plan']).nullable().optional(), // Runtime collaboration/planning mode (null = reset)
  accessMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).nullable().optional(), // Runtime filesystem/tool access mode (null = reset)
  claudePermissionMode: z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']).nullable().optional(), // Claude permission override when mode is default (null = reset)
  codexCollaborationMode: z.enum(['default', 'plan']).nullable().optional(), // Codex-native collaboration mode override (null = reset)
  codexPermissionProfile: z.string().nullable().optional(), // Codex permission profile id, e.g. :workspace (null = reset)
  approvalPolicy: z.enum(['untrusted', 'on-failure', 'on-request', 'never']).nullable().optional(), // Codex approval policy override (null = reset)
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).nullable().optional(), // Codex sandbox override (null = reset)
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
  reasoningEffort: z.string().nullable().optional() // Reasoning effort for this message (null = reset)
})

export type MessageMeta = z.infer<typeof MessageMetaSchema>

/**
 * API response types
 */
export const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

// Image content schema for user messages
const ImageContentSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string() // Base64 encoded image data
  })
})

// User message content can be text-only or multipart (text + images)
const UserContentSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  z.object({
    type: z.literal('multipart'),
    parts: z.array(z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      ImageContentSchema
    ]))
  })
])

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: UserContentSchema,
  localKey: z.string().optional(), // Mobile messages include this
  meta: MessageMetaSchema.optional()
})

export type UserMessage = z.infer<typeof UserMessageSchema>

/**
 * Extract text from user message content (handles both text and multipart)
 */
export function getUserMessageText(content: z.infer<typeof UserContentSchema>): string {
  if (content.type === 'text') {
    return content.text;
  }
  // Multipart: concatenate all text parts
  const textParts = content.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text);
  return textParts.join('\n');
}

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.any()
  }),
  meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

export type Metadata = {
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  machineId?: string,
  claudeSessionId?: string, // Claude Code session ID
  tools?: string[],
  slashCommands?: string[],
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  startedBy?: 'daemon' | 'terminal',
  // Lifecycle state management
  lifecycleState?: 'running' | 'archiveRequested' | 'archived' | string,
  lifecycleStateSince?: number,
  archivedBy?: string,
  archiveReason?: string,
  flavor?: string
};

export type AgentRequestKind = 'permission' | 'questionnaire' | 'plan_decision'

export type AgentQuestionnaireOption = {
  label: string
  description?: string | null
}

export type AgentQuestionnaireQuestion = {
  id: string
  header?: string | null
  question: string
  options?: AgentQuestionnaireOption[] | null
  isOther?: boolean
  isSecret?: boolean
  multiSelect?: boolean
}

export type AgentQuestionnaire = {
  provider: 'claude' | 'codex'
  questions: AgentQuestionnaireQuestion[]
  autoResolutionMs?: number | null
}

export type AgentQuestionnaireAnswer = {
  answers: string[]
}

export type AgentQuestionnaireAnswerMap = Record<string, AgentQuestionnaireAnswer>

export type AgentPlanDecisionAction = 'approve' | 'stay_in_plan'

export type AgentPlanDecisionPlan = {
  id: string
  provider?: 'claude' | 'codex' | string
  text?: string
  explanation?: string | null
  steps?: Array<{ step: string; status?: string | null }>
  status?: 'updated' | 'complete'
}

export type AgentPlanDecision = {
  provider: 'claude' | 'codex' | string
  planId: string
  plan?: AgentPlanDecisionPlan
  actions: AgentPlanDecisionAction[]
}

export type AgentStateRequest = {
  kind?: AgentRequestKind
  tool: string,
  arguments: any,
  createdAt: number,
  questionnaire?: AgentQuestionnaire
  planDecision?: AgentPlanDecision
}

export type AgentStateCompletedRequest = AgentStateRequest & {
  completedAt: number,
  status: 'canceled' | 'denied' | 'approved' | 'answered' | 'expired' | 'stayed_in_plan',
  reason?: string,
  mode?: PermissionMode,
  decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
  allowTools?: string[],
  answers?: AgentQuestionnaireAnswerMap
  planDecisionResult?: AgentPlanDecisionAction
  feedback?: string
}

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  requests?: {
    [id: string]: AgentStateRequest
  }
  completedRequests?: {
    [id: string]: AgentStateCompletedRequest
  }
}
