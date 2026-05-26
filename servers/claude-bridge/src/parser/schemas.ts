import { z } from "zod";

/**
 * Zod schemas for Claude Code session JSONL events.
 *
 * Based on audit of 15,733 root events across 13 sessions and 15 versions of
 * Claude Code (2.1.90 → 2.1.145). See docs/architecture.md for the audit summary.
 *
 * Design principles:
 * - Use `.passthrough()` everywhere for forward compatibility — Claude Code
 *   adds fields between versions (`slug`, `attributionSkill`, `container`, ...).
 * - Discriminated union on top-level `type` field.
 * - Inner polymorphic blocks (message.content[], attachment.attachment, ...)
 *   have their own unions.
 * - Schemas validate SHAPE, not VALUES — values are intentionally permissive.
 */

// ============================================================================
// Common scalars
// ============================================================================

export const UuidSchema = z.string().uuid();
export const TimestampSchema = z.string(); // ISO 8601, validated by shape elsewhere

const Iso8601 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

// ============================================================================
// Message content blocks (assistant + user)
// ============================================================================

export const TextBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

export const ThinkingBlockSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
  })
  .passthrough();

export const ToolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

export const ToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.unknown(), // can be string or array of blocks
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const ImageBlockSchema = z
  .object({
    type: z.literal("image"),
    source: z.unknown(),
  })
  .passthrough();

export const DocumentBlockSchema = z
  .object({
    type: z.literal("document"),
    source: z.unknown(),
  })
  .passthrough();

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
  DocumentBlockSchema,
]);

// ============================================================================
// Message envelopes (Anthropic SDK shape, nested under .message)
// ============================================================================

export const AssistantMessageSchema = z
  .object({
    id: z.string(),
    role: z.literal("assistant"),
    model: z.string(), // "claude-opus-4-7", "<synthetic>", ...
    content: z.array(ContentBlockSchema),
    stop_reason: z.string().nullable(),
    stop_sequence: z.string().nullable(),
    usage: z.unknown(),
  })
  .passthrough();

export const UserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
  })
  .passthrough();

// ============================================================================
// Top-level event base — fields present on most message-level events
// ============================================================================

const MessageEventBase = z
  .object({
    uuid: UuidSchema,
    parentUuid: UuidSchema.nullable(),
    sessionId: UuidSchema,
    timestamp: Iso8601,
    cwd: z.string(),
    gitBranch: z.string(),
    version: z.string(),
    userType: z.string(),
    entrypoint: z.string(),
    isSidechain: z.boolean(),
  })
  .passthrough();

// ============================================================================
// 9 root event types (discriminated union on `type`)
// ============================================================================

export const AssistantEventSchema = MessageEventBase.extend({
  type: z.literal("assistant"),
  message: AssistantMessageSchema,
  requestId: z.string().optional(),
});

export const UserEventSchema = MessageEventBase.extend({
  type: z.literal("user"),
  message: UserMessageSchema,
  promptId: z.string().optional(),
  toolUseResult: z.unknown().optional(),
  sourceToolAssistantUUID: UuidSchema.optional(),
  permissionMode: z.string().optional(),
  origin: z
    .object({
      kind: z.string(),
    })
    .passthrough()
    .optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  isVisibleInTranscriptOnly: z.boolean().optional(),
});

export const AttachmentEventSchema = MessageEventBase.extend({
  type: z.literal("attachment"),
  attachment: z.record(z.unknown()),
});

export const SystemEventSchema = MessageEventBase.extend({
  type: z.literal("system"),
  subtype: z.string(),
  parentUuid: UuidSchema.nullable(),
  logicalParentUuid: UuidSchema.optional(),
  compactMetadata: z.record(z.unknown()).optional(),
  level: z.string().optional(),
  isMeta: z.boolean().optional(),
});

// Metadata-only events (no uuid/cwd, much lighter shape)

export const QueueOperationEventSchema = z
  .object({
    type: z.literal("queue-operation"),
    operation: z.enum(["enqueue", "dequeue", "remove"]),
    timestamp: Iso8601,
    sessionId: UuidSchema,
    content: z.string().optional(),
  })
  .passthrough();

export const LastPromptEventSchema = z
  .object({
    type: z.literal("last-prompt"),
    sessionId: UuidSchema,
    lastPrompt: z.string(),
    leafUuid: UuidSchema.optional(),
  })
  .passthrough();

export const CustomTitleEventSchema = z
  .object({
    type: z.literal("custom-title"),
    sessionId: UuidSchema,
    customTitle: z.string(),
  })
  .passthrough();

export const AiTitleEventSchema = z
  .object({
    type: z.literal("ai-title"),
    sessionId: UuidSchema,
    aiTitle: z.string(),
  })
  .passthrough();

export const FileHistorySnapshotEventSchema = z
  .object({
    type: z.literal("file-history-snapshot"),
    messageId: UuidSchema,
    isSnapshotUpdate: z.boolean(),
    snapshot: z.record(z.unknown()),
  })
  .passthrough();

// ============================================================================
// Discriminated union of all event types
// ============================================================================

export const SessionEventSchema = z.discriminatedUnion("type", [
  AssistantEventSchema,
  UserEventSchema,
  AttachmentEventSchema,
  SystemEventSchema,
  QueueOperationEventSchema,
  LastPromptEventSchema,
  CustomTitleEventSchema,
  AiTitleEventSchema,
  FileHistorySnapshotEventSchema,
]);

// ============================================================================
// Inferred TypeScript types
// ============================================================================

export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;

export type AssistantEvent = z.infer<typeof AssistantEventSchema>;
export type UserEvent = z.infer<typeof UserEventSchema>;
export type AttachmentEvent = z.infer<typeof AttachmentEventSchema>;
export type SystemEvent = z.infer<typeof SystemEventSchema>;
export type QueueOperationEvent = z.infer<typeof QueueOperationEventSchema>;
export type LastPromptEvent = z.infer<typeof LastPromptEventSchema>;
export type CustomTitleEvent = z.infer<typeof CustomTitleEventSchema>;
export type AiTitleEvent = z.infer<typeof AiTitleEventSchema>;
export type FileHistorySnapshotEvent = z.infer<typeof FileHistorySnapshotEventSchema>;

export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * Type guard helpers — terser than z.discriminatedUnion narrowing in TS.
 */
export const isMessageEvent = (
  e: SessionEvent,
): e is AssistantEvent | UserEvent | AttachmentEvent | SystemEvent =>
  e.type === "assistant" || e.type === "user" || e.type === "attachment" || e.type === "system";

export const isMetadataEvent = (
  e: SessionEvent,
): e is
  | QueueOperationEvent
  | LastPromptEvent
  | CustomTitleEvent
  | AiTitleEvent
  | FileHistorySnapshotEvent => !isMessageEvent(e);
