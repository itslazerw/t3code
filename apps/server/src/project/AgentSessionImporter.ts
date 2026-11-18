// @effect-diagnostics nodeBuiltinImport:off - pictures are read line by line from a transcript that can be gigabytes.
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type ChatImageAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import {
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

const isProjectionStoreThreadNotFoundError = Schema.is(
  ProjectionStore.ProjectionStoreThreadNotFoundError,
);

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionPictureReadError extends Schema.TaggedError<AgentSessionPictureReadError>()(
  "AgentSessionPictureReadError",
  { message: Schema.String },
) {}

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

// ACP imports read the history while holding the session-mutation lock, and an agent can
// leave session/resume or initialize unanswered. Longer than session/load's own deadline.
const NATIVE_HISTORY_READ_TIMEOUT = "2 minutes";

/**
 * Whether a thread bound to a native session still lacks its native history.
 * Once a turn has run, the native session also holds that turn's messages, so
 * its history can no longer be imported as run-less items.
 */
export function isNativeHistoryPending(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly hasRun: boolean;
}): boolean {
  return input.historyOrigin !== "v1_import" && !input.hasRun;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

type HistoryMessage = Omit<AgentSessionScanner.AgentSessionThreadMessage, "role"> & {
  readonly role: AgentSessionScanner.AgentSessionThreadMessage["role"] | "reasoning";
};

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: HistoryMessage;
  /** Catch-up items take ids and places after what the thread already shows. */
  readonly suffix?: string;
  readonly ordinal?: number;
  readonly attachments?: ReadonlyArray<ChatImageAttachment>;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.ordinal ?? input.index + 1;
  const suffix = input.suffix ?? historySuffix(input.index);
  const attachments = input.message.role === "user" ? (input.attachments ?? []) : [];
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments,
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}

const historySuffix = (index: number) => String(index).padStart(6, "0");

const timeKey = (value: string) =>
  Option.match(DateTime.make(value), {
    onNone: () => value,
    onSome: (time) => DateTime.formatIso(time),
  });

/**
 * Pictures pasted into the transcript's user records, by record time. T3's transcript
 * reader leaves picture data out (it would blow its memory budget), so this reads the
 * file line by line and parses only user records that carry a picture.
 */
async function readTranscriptPictures(
  filePath: string,
  wanted: ReadonlySet<string>,
): Promise<Map<string, Array<{ readonly mimeType: string; readonly data: string }>>> {
  const found = new Map<string, Array<{ readonly mimeType: string; readonly data: string }>>();
  if (wanted.size === 0) return found;
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.includes('"type":"image"') || !line.includes('"type":"user"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const { type, timestamp, message } = record as {
      type?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown };
    };
    if (type !== "user" || typeof timestamp !== "string") continue;
    const key = timeKey(timestamp);
    if (!wanted.has(key) || !Array.isArray(message?.content)) continue;
    const pictures = message.content.flatMap((block: unknown) => {
      const source = (block as { type?: unknown; source?: Record<string, unknown> } | null)
        ?.source;
      return (block as { type?: unknown } | null)?.type === "image" &&
        source?.type === "base64" &&
        typeof source.media_type === "string" &&
        /^image\//i.test(source.media_type) &&
        typeof source.data === "string" &&
        source.data.length > 0
        ? [{ mimeType: source.media_type.toLowerCase(), data: source.data }]
        : [];
    });
    if (pictures.length > 0) found.set(key, pictures);
  }
  return found;
}

/** Saves the pictures of these history messages as T3 attachments, keyed by message suffix. */
const historyPictures = Effect.fn("AgentSessionImporter.historyPictures")(function* (input: {
  readonly threadId: ThreadId;
  readonly transcriptPath: string | undefined;
  readonly items: ReadonlyArray<{ readonly message: HistoryMessage; readonly suffix: string }>;
}) {
  const byItem = new Map<string, ReadonlyArray<ChatImageAttachment>>();
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const transcriptPath = input.transcriptPath;
  if (Option.isNone(config) || transcriptPath === undefined) return byItem;
  const users = input.items.filter((item) => item.message.role === "user");
  const pictures = yield* Effect.tryPromise({
    try: () =>
      readTranscriptPictures(
        transcriptPath,
        new Set(users.map((item) => timeKey(item.message.createdAt))),
      ),
    catch: (cause) => new AgentSessionPictureReadError({ message: String(cause) }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read pictures from a Claude transcript", { cause }).pipe(
        Effect.as(new Map<string, never>()),
      ),
    ),
  );
  for (const { message, suffix } of users) {
    const found = pictures.get(timeKey(message.createdAt));
    if (found === undefined) continue;
    const messageId = `${input.threadId}:${suffix}`;
    const saved: Array<ChatImageAttachment> = [];
    found.forEach((picture, index) => {
      const bytes = Buffer.from(picture.data, "base64");
      if (bytes.length === 0 || bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return;
      const id = createDeterministicAttachmentId(
        input.threadId,
        chatAttachmentStableKey(messageId, index, bytes),
      );
      if (id === null) return;
      const extension = (picture.mimeType.split("/")[1] ?? "png")
        .replace("jpeg", "jpg")
        .replace(/[^a-z0-9]/g, "");
      const attachment: ChatImageAttachment = {
        type: "image",
        id,
        name: `picture-${index + 1}.${extension || "png"}`,
        mimeType: picture.mimeType,
        sizeBytes: bytes.length,
      };
      const path = resolveAttachmentPath({
        attachmentsDir: config.value.attachmentsDir,
        attachment,
      });
      if (path === null) return;
      try {
        NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
        NodeFS.writeFileSync(path, bytes, { flag: "wx" });
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") return;
      }
      saved.push(attachment);
    });
    if (saved.length > 0) byItem.set(suffix, saved);
  }
  return byItem;
});

function historyTruncatedEvents(input: {
  readonly threadId: ThreadId;
  readonly omittedMessageCount: number;
  readonly at: DateTime.Utc;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, omittedMessageCount: count, at } = input;
  if (count <= 0) return [];
  const id = `${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`;
  return [
    {
      id: EventId.make(id),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: {
        id: TurnItemId.make(id),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "system_notice",
        message: `${count} earlier ${count === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
      },
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    // Imports run in full access, except under a policy ceiling: then in the project's default,
    // which the policy keeps under it, so imported threads never sit above the ceiling.
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
            ),
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, input.projectId, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    // The thread's project owns its transcripts: a linked worktree import records the worktree as cwd.
    const completedSources = (yield* Effect.forEach(runtimeRows, (runtime) => {
      const imported = AgentSessionScanner.decodeImportedTranscriptPayload(
        runtime.runtimePayload,
      ).pipe(Option.flatMapNullishOr((payload) => payload.importedTranscripts));
      if (Option.isNone(imported) || imported.value.length === 0) return Effect.succeed([]);
      return orchestrator.getThreadRecords(runtime.threadId, []).pipe(
        Effect.map(({ thread }) => (thread.projectId === input.projectId ? imported.value : [])),
        Effect.catch((cause) =>
          isProjectionStoreThreadNotFoundError(cause.cause)
            ? Effect.succeed([])
            : Effect.fail(new AgentSessionScanError({ operation: "read-projects", cause })),
        ),
      );
    })).flat();
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          // Pi resumes by session file path; its session UUID only names the thread.
          const nativeThreadId =
            thread.source === "pi" ? source.filePath : thread.providerSessionId;
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "claudeAgent"
                  ? { threadId, resume: thread.providerSessionId }
                  : { threadId: nativeThreadId },
              runtimePayload: { cwd: outcome.worktree?.path ?? project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* Effect.option(
            orchestrator.getThreadRecords(threadId, ["messages"]),
          );
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            // A transcript can change after the import, so record it only when the
            // thread already holds exactly its messages.
            const stored = existing.value.messages;
            if (
              stored.length !== thread.messages.length ||
              stored.some(
                (message, index) =>
                  message.role !== thread.messages[index]?.role ||
                  message.text !== thread.messages[index]?.text,
              )
            ) {
              return false;
            }
            yield* persistRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            importedThreadIds.add(threadId);
            return null;
          }

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: outcome.worktree?.branch ?? null,
            worktreePath: outcome.worktree?.path ?? null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: nativeThreadId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const committed = yield* eventSink.write({
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...historyTruncatedEvents({
                threadId,
                omittedMessageCount: thread.omittedMessageCount,
                at: createdAt,
              }),
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          if (committed.length === 0) return null;
          yield* persistRuntime;
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  /**
   * Loading a native session replays its history only into the adapter's own
   * snapshot, so copy that snapshot into the thread as run-less history. The
   * `v1_import` origin keeps it in forks and marks the import done, so a call
   * after a failed read repairs the thread and any later call does nothing.
   */
  const importNativeHistory = Effect.fn("importNativeHistoryV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) {
    const pendingThread = Effect.map(
      orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs"]),
      (records) =>
        isNativeHistoryPending({
          historyOrigin: records.thread.historyOrigin,
          hasRun: records.runs.length > 0,
        })
          ? records
          : null,
    );
    // Thread commands write whole thread rows, so hold their lock from the
    // re-read through the write to keep both this marker and their changes.
    const commit = (messages: ReadonlyArray<HistoryMessage>) =>
      threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* pendingThread;
          if (current === null) return 0;
          yield* eventSink.write({
            events: [
              ...messages.flatMap((message, index) =>
                messageEvents({ threadId: input.threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:native-history`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: current.thread.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...current.thread, historyOrigin: "v1_import" },
              },
            ],
          });
          return messages.length;
        }),
      );
    const records = yield* pendingThread;
    if (records === null) return 0;
    const { thread, providerThreads } = records;
    const providerThread = providerThreads.find(
      (candidate) => candidate.appThreadId === input.threadId && candidate.nativeThreadRef !== null,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
    if (providerThread === undefined || nativeThreadId == null) return 0;
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: providerThread.providerInstanceId,
      threadId: input.threadId,
    });
    // The registry admits this open against sign-in changes, like any other open.
    const adapter = yield* registry.get(thread.modelSelection.instanceId);
    const snapshot = yield* adapter
      .openSession({
        threadId: input.threadId,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: {
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          cwd: thread.worktreePath ?? input.workspaceRoot,
        },
        initialNativeThreadId: nativeThreadId,
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      })
      .pipe(
        Effect.flatMap((session) => session.readThreadSnapshot({ providerThread })),
        Effect.timeout(NATIVE_HISTORY_READ_TIMEOUT),
        Effect.scoped,
      );
    const reasoningIds = new Set(snapshot.reasoningMessageIds);
    const messages = snapshot.messages.flatMap((message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
        ? [
            {
              role: reasoningIds.has(message.id) ? ("reasoning" as const) : message.role,
              text: message.text,
              createdAt: DateTime.formatIso(message.createdAt),
            },
          ]
        : [],
    );
    // Loading the session can take a while, and the thread is usable meanwhile.
    return yield* commit(messages);
  });

  /**
   * A Claude thread linked to an existing session but holding none of its messages,
   * such as one another tool created, gets them from the session's transcript. The
   * transcript is only read. Like importNativeHistory, `v1_import` marks it done.
   */
  const importClaudeTranscriptHistory = Effect.fn("importClaudeTranscriptHistory")(
    function* (input: { readonly threadId: ThreadId }) {
      const pendingThread = Effect.map(
        orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs", "messages"]),
        (records) =>
          records.thread.deletedAt === null &&
          records.messages.length === 0 &&
          isNativeHistoryPending({
            historyOrigin: records.thread.historyOrigin,
            hasRun: records.runs.length > 0,
          })
            ? records
            : null,
      );
      const records = yield* pendingThread;
      if (records === null) return 0;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.appThreadId === input.threadId &&
          candidate.driver === "claudeAgent" &&
          candidate.nativeThreadRef !== null,
      );
      const sessionId = providerThread?.nativeThreadRef?.nativeId;
      if (providerThread === undefined || sessionId == null) return 0;
      const history = yield* scanner.claudeSessionHistory({
        providerInstanceId: providerThread.providerInstanceId,
        sessionId,
      });
      if (history === null || history.messages.length === 0) return 0;
      const pictures = yield* historyPictures({
        threadId: input.threadId,
        transcriptPath: history.transcriptPath,
        items: history.messages.map((message, index) => ({ message, suffix: historySuffix(index) })),
      });
      return yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* pendingThread;
          if (current === null) return 0;
          yield* eventSink.write({
            events: [
              ...historyTruncatedEvents({
                threadId: input.threadId,
                omittedMessageCount: history.omittedMessageCount,
                at: dateTime(history.createdAt),
              }),
              ...history.messages.flatMap((message, index) =>
                messageEvents({
                  threadId: input.threadId,
                  index,
                  message,
                  attachments: pictures.get(historySuffix(index)) ?? [],
                }),
              ),
              {
                id: EventId.make(
                  `${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:claude-transcript-history`,
                ),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: current.thread.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...current.thread, historyOrigin: "v1_import" },
              },
            ],
          });
          return history.messages.length;
        }),
      );
    },
  );

  /**
   * A thread linked to a Claude session does not see the session go on in another app
   * (the Claude desktop app). This appends the transcript's newer messages, skipping
   * T3's own turns (they reach the transcript too) and doing nothing while a run is active.
   */
  const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
  const catchUpClaudeTranscript = Effect.fn("catchUpClaudeTranscript")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const read = orchestrator.getThreadRecords(input.threadId, [
      "providerThreads",
      "runs",
      "messages",
      "turnItems",
    ]);
    type Records = Effect.Success<typeof read>;
    // A thread that already shows messages; an empty one gets its history from the import.
    const ready = (records: Records) =>
      records.thread.deletedAt === null &&
      records.messages.length > 0 &&
      !records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
    // The cheap read first: most threads opened are not linked to a Claude session.
    const link = yield* orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs"]);
    if (
      link.thread.deletedAt !== null ||
      !link.providerThreads.some(
        (candidate) =>
          candidate.appThreadId === input.threadId &&
          candidate.driver === "claudeAgent" &&
          candidate.nativeThreadRef !== null,
      )
    ) {
      return 0;
    }
    const records = yield* read;
    if (!ready(records)) return 0;
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.appThreadId === input.threadId &&
        candidate.driver === "claudeAgent" &&
        candidate.nativeThreadRef !== null,
    );
    const sessionId = providerThread?.nativeThreadRef?.nativeId;
    if (providerThread === undefined || sessionId == null) return 0;
    const history = yield* scanner.claudeSessionHistory({
      providerInstanceId: providerThread.providerInstanceId,
      sessionId,
    });
    if (history === null) return 0;
    const items = history.messages.map((message, index) => ({
      message,
      suffix: `c${Date.parse(message.createdAt)}-${index}`,
    }));
    const fresh = (current: Records) => {
      const newest = current.messages.reduce(
        (max, message) => Math.max(max, DateTime.toEpochMillis(message.createdAt)),
        0,
      );
      const recent = new Set(current.messages.slice(-50).map((message) => message.text.trim()));
      return items.filter(
        ({ message }) =>
          Date.parse(message.createdAt) > newest && !recent.has(message.text.trim()),
      );
    };
    const candidates = fresh(records);
    if (candidates.length === 0) return 0;
    const pictures = yield* historyPictures({
      threadId: input.threadId,
      transcriptPath: history.transcriptPath,
      items: candidates,
    });
    return yield* threadCommands.withLock(
      input.threadId,
      Effect.gen(function* () {
        const current = yield* read;
        if (!ready(current)) return 0;
        const appended = fresh(current);
        if (appended.length === 0) return 0;
        const base = current.turnItems.reduce((max, item) => Math.max(max, item.ordinal), 0);
        yield* eventSink.write({
          events: appended.flatMap(({ message, suffix }, index) =>
            messageEvents({
              threadId: input.threadId,
              index,
              message,
              suffix,
              ordinal: base + index + 1,
              attachments: pictures.get(suffix) ?? [],
            }),
          ),
        });
        return appended.length;
      }),
    );
  });

  /**
   * Threads that loaded their old messages before pictures were imported get them added
   * to those same messages: an imported user message carries its transcript record's time.
   */
  const fillHistoryPictures = Effect.fn("fillHistoryPictures")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const link = yield* orchestrator.getThreadRecords(input.threadId, ["providerThreads"]);
    const providerThread = link.providerThreads.find(
      (candidate) =>
        candidate.appThreadId === input.threadId &&
        candidate.driver === "claudeAgent" &&
        candidate.nativeThreadRef !== null,
    );
    const sessionId = providerThread?.nativeThreadRef?.nativeId;
    if (link.thread.deletedAt !== null || providerThread === undefined || sessionId == null) {
      return 0;
    }
    const records = yield* orchestrator.getThreadRecords(input.threadId, ["messages", "turnItems"]);
    const bare = records.turnItems.flatMap((item) =>
      item.type === "user_message" && item.runId === null && item.attachments.length === 0
        ? [item]
        : [],
    );
    if (bare.length === 0) return 0;
    const history = yield* scanner.claudeSessionHistory({
      providerInstanceId: providerThread.providerInstanceId,
      sessionId,
    });
    if (history === null) return 0;
    const messagesById = new Map(records.messages.map((message) => [message.id, message]));
    const items = bare.flatMap((item) => {
      const message = messagesById.get(item.messageId);
      const prefix = `${input.threadId}:`;
      return message === undefined || !message.id.startsWith(prefix)
        ? []
        : [
            {
              item,
              message,
              suffix: message.id.slice(prefix.length),
              history: {
                role: "user" as const,
                text: message.text,
                createdAt: DateTime.formatIso(message.createdAt),
              },
            },
          ];
    });
    const pictures = yield* historyPictures({
      threadId: input.threadId,
      transcriptPath: history.transcriptPath,
      items: items.map(({ history: message, suffix }) => ({ message, suffix })),
    });
    const found = items.flatMap((entry) => {
      const attachments = pictures.get(entry.suffix);
      return attachments === undefined ? [] : [{ ...entry, attachments }];
    });
    if (found.length === 0) return 0;
    yield* eventSink.write({
      events: found.flatMap(({ item, message, suffix, attachments }) => [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:pictures:message:${input.threadId}:${suffix}`),
          type: "message.updated" as const,
          threadId: input.threadId,
          occurredAt: message.createdAt,
          payload: { ...message, attachments },
        },
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:pictures:turn-item:${input.threadId}:${suffix}`),
          type: "turn-item.updated" as const,
          threadId: input.threadId,
          occurredAt: message.createdAt,
          payload: { ...item, attachments },
        },
      ]),
    });
    return found.length;
  });

  return {
    importRecentAgentThreads,
    importNativeHistory,
    importClaudeTranscriptHistory,
    catchUpClaudeTranscript,
    fillHistoryPictures,
  };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
