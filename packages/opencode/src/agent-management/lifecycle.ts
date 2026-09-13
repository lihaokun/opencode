import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Path, Scope } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { path } from "@opencode-ai/core/effect/app-node-platform"
import { AppProcess } from "@opencode-ai/core/process"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Session } from "../session/session"
import { SessionRunState } from "../session/run-state"
import { SessionID, MessageID } from "../session/schema"
import { Truncate } from "../tool/truncate"
import { Worktree } from "../worktree"
import { AgentDelegation } from "./delegation"
import { AgentInbox } from "./inbox"
import { AgentTree } from "./tree"
import { AgentWorkdir } from "./workdir"
import { AgentManagement } from "./schema"

export const DEFAULT_SUBAGENT_DEPTH = 3

export interface CreateInput {
  caller: SessionID
  name?: string
  subagent_type: string
  description: string
  prompt: string
  cwd?: string
  model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  variant: string | undefined
  ops: AgentManagement.AgentPromptOps
}

export interface CreateResult {
  session_id: SessionID
  name: string | undefined
  agent_type: string
  title: string
  workdir: AgentManagement.AgentWorkdir
  model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
}

export interface Interface {
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<
    CreateResult,
    | AgentManagement.DepthLimitReached
    | AgentManagement.AgentTypeNotFound
    | AgentManagement.AgentNameConflict
    | AgentManagement.AgentNotFound
    | AgentManagement.WorktreeUnavailable
  >
  readonly stop: (input: {
    caller: SessionID
    target: SessionID
    ops: AgentManagement.AgentPromptOps
  }) => Effect.Effect<
    AgentManagement.StopOutcome,
    AgentManagement.NotAChild | AgentManagement.AgentNotFound
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentLifecycle") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const tree = yield* AgentTree.Service
    const inbox = yield* AgentInbox.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const background = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service
    const truncate = yield* Truncate.Service
    const scope = yield* Scope.Scope
    // Captured here so the closures below carry them; prepareWorkdir needs the
    // filesystem, process and worktree services and the returned Interface must
    // have no outstanding requirements.
    const pathSvc = yield* Path.Path
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const worktree = yield* Worktree.Service

    /**
     * Unlocked, best-effort. Two concurrent creations can both pass and produce
     * the same name, and that is an allowed outcome: a name is a convenience
     * alias, not an identity, and paying for a lock or a unique index to protect
     * one is not worth it. Resolution contains the fallout by returning every
     * candidate and refusing rather than picking one.
     */
    const checkName = Effect.fn("AgentLifecycle.checkName")(function* (caller: SessionID, name: string) {
      if (name.startsWith(AgentManagement.SESSION_ID_PREFIX)) {
        return yield* new AgentManagement.AgentNameConflict({ name, reason: "reserved_prefix" })
      }
      const root = yield* tree.root(caller)
      const rootSession = yield* sessions
        .get(root)
        .pipe(Effect.mapError(() => new AgentManagement.AgentNotFound({ session_id: root })))
      const members = yield* tree.descendants(root, 0)
      const taken = [rootSession.metadata?.[AgentManagement.METADATA_AGENT_NAME], ...members.map((m) => m.name)]
      if (taken.some((existing) => existing === name)) {
        return yield* new AgentManagement.AgentNameConflict({ name, reason: "taken" })
      }
    })

    const workdirInstruction = (workdir: AgentManagement.AgentWorkdir, sourceDirectory: string) =>
      workdir.source === "generated_empty_workspace"
        ? [
            `Source directory: ${sourceDirectory}`,
            `Your workspace: ${workdir.path}`,
            "The workspace is initially empty.",
            "Copy only the files you need and use absolute paths for all operations.",
          ].join("\n")
        : [
            `Your working directory: ${workdir.path}`,
            "Use absolute paths for all file operations and pass workdir explicitly to shell commands.",
          ].join("\n")

    /**
     * The one place an outcome is delivered automatically. A delegation is a task
     * the creator handed out and is waiting on; a later message is not, which is
     * why agent_send produces nothing.
     */
    const startDelegation = Effect.fn("AgentLifecycle.startDelegation")(function* (input: {
      session: Session.Info
      caller: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      variant: string | undefined
      parts: Awaited<ReturnType<AgentManagement.AgentPromptOps["resolvePromptParts"]>> extends never
        ? never
        : Parameters<AgentManagement.AgentPromptOps["prompt"]>[0]["parts"]
      description: string
      ops: AgentManagement.AgentPromptOps
    }) {
      const limits = yield* truncate.limits()

      const run = Effect.gen(function* () {
        const result = yield* input.ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: input.session.id,
          agent: input.agent,
          model: input.model,
          variant: input.variant,
          parts: input.parts,
        })
        return yield* AgentDelegation.toExit(AgentDelegation.classify(result, input.session.id, limits))
      }).pipe(Effect.onInterrupt(() => input.ops.cancel(input.session.id)))

      // Job id is the child SessionID, keeping the existing identity convention.
      yield* background.start({
        id: input.session.id,
        type: "agent",
        title: input.description,
        metadata: { parentSessionId: input.caller, sessionId: input.session.id, model: input.model },
        run,
      })

      // Registered once. Silent on cancelled, because a cancellation notice comes
      // from stop; adding one here would produce two for a single agent_stop.
      yield* background
        .wait({ id: input.session.id })
        .pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )

      function inject(state: "completed" | "error", text: string) {
        return Effect.gen(function* () {
          // Re-read the parent's identity at delivery time. Passing no model lets
          // the parent's agent definition override and persist over its current
          // model, and a variant captured when the child was created would revert
          // a parent that switched mid-flight.
          const parent = yield* sessions.get(input.caller)
          yield* input.ops.prompt({
            sessionID: input.caller,
            agent: parent.agent ?? input.agent,
            model: parent.model
              ? { providerID: parent.model.providerID, modelID: parent.model.id }
              : undefined,
            variant: parent.model?.variant === "default" ? undefined : parent.model?.variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: AgentDelegation.renderOutput({
                  sessionID: input.session.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Agent completed: ${input.description}`
                      : `Agent failed: ${input.description}`,
                  text,
                }),
              },
            ],
          })
        }).pipe(Effect.ignore)
      }
    })

    const create = Effect.fn("AgentLifecycle.create")(function* (input: CreateInput) {
      // The caller is a SessionID, so the real parent has to be fetched before
      // its permission ruleset or suggested workdir can be read.
      const parent = yield* sessions
        .get(input.caller)
        .pipe(Effect.mapError(() => new AgentManagement.AgentNotFound({ session_id: input.caller })))

      const cfg = yield* config.get()
      const limit = cfg.subagent_depth ?? DEFAULT_SUBAGENT_DEPTH
      const depth = yield* tree.callerDepth(input.caller)
      // Second line of defence: tool visibility already withdraws `agent` at the
      // limit, but plugins and direct entries do not go through the tool list.
      if (depth >= limit) return yield* new AgentManagement.DepthLimitReached({ depth, limit })

      // Before the workspace and the Session, so a name clash leaves no orphan
      // directory behind.
      if (input.name) yield* checkName(input.caller, input.name)

      const available = (yield* agents.list()).filter((item) => !item.hidden).map((item) => item.name)
      // Agent.get is typed as returning Info but hands back undefined for an
      // unknown name — the same shape createUserMessage guards against.
      const next = yield* agents.get(input.subagent_type)
      if (!next) {
        return yield* new AgentManagement.AgentTypeNotFound({ subagent_type: input.subagent_type, available })
      }

      // The subagent definition's own model wins; otherwise inherit the model the
      // caller is using for this very turn. The variant is inherited only when
      // the subagent has not pinned a model — carrying a parent's variant onto a
      // different model is meaningless.
      const model = next.model
        ? { providerID: next.model.providerID, modelID: next.model.modelID }
        : input.model
      const variant = next.model ? undefined : input.variant

      const workdir = yield* AgentWorkdir.prepareWorkdir({
        cwd: input.cwd,
        parentWorkdir: parent.metadata?.[AgentManagement.METADATA_AGENT_WORKDIR],
      }).pipe(
        Effect.map((result) => ({ ...result, enforced: false as const })),
        Effect.provideService(Path.Path, pathSvc),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(AppProcess.Service, appProcess),
        Effect.provideService(Worktree.Service, worktree),
      )

      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })

      const session = yield* sessions.create({
        parentID: input.caller,
        title: `${input.description} (@${next.name} subagent)`,
        agent: next.name,
        // Persisted at creation, not on the first async prompt: until it is
        // bound, any agent_send would see a Session with no model and rewrite it
        // through the fallback chain.
        model: { id: model.modelID, providerID: model.providerID, variant: variant ?? "default" },
        permission: childPermission,
        metadata: {
          ...(input.name ? { [AgentManagement.METADATA_AGENT_NAME]: input.name } : {}),
          [AgentManagement.METADATA_AGENT_WORKDIR]: workdir,
        },
      })

      // Keeps the parts structure: resolvePromptParts expands @file references
      // into attachment parts, and flattening to a string drops them.
      const resolved = yield* input.ops.resolvePromptParts(input.prompt)
      const parts = [
        { type: "text" as const, text: workdirInstruction(workdir, parent.directory) },
        ...resolved,
      ]

      yield* startDelegation({
        session,
        caller: input.caller,
        agent: next.name,
        model,
        variant,
        parts,
        description: input.description,
        ops: input.ops,
      })

      // No live status: the job may not have started yet, and status has exactly
      // one source, which is the projection.
      return {
        session_id: session.id,
        name: input.name,
        agent_type: next.name,
        title: session.title,
        workdir,
        model,
      }
    })

    const stop = Effect.fn("AgentLifecycle.stop")(function* (input: {
      caller: SessionID
      target: SessionID
      ops: AgentManagement.AgentPromptOps
    }) {
      if (!(yield* tree.isChild(input.caller, input.target))) {
        return yield* new AgentManagement.NotAChild({ caller: input.caller, target: input.target })
      }

      const targetDepth = (yield* tree.callerDepth(input.caller)) + 1
      const descendants = yield* tree.descendants(input.target, targetDepth)
      const buckets = new Map<number, SessionID[]>([[targetDepth, [input.target]]])
      for (const member of descendants) {
        const bucket = buckets.get(member.depth) ?? []
        bucket.push(member.session_id)
        buckets.set(member.depth, bucket)
      }
      // Deepest first. This is initiation order only — nothing is notified inside
      // the stop set, so there is no resurrection to order against; it just
      // narrows the window for a middle layer to spawn before it is stopped.
      const layers = [...buckets.entries()].toSorted((a, b) => b[0] - a[0]).map(([, ids]) => ids)

      const stopped: SessionID[] = []
      const failed: { session_id: SessionID; reason: string }[] = []
      for (const level of layers) {
        yield* Effect.forEach(
          level,
          (member) =>
            runState.cancel(member).pipe(
              Effect.matchEffect({
                onSuccess: () => Effect.sync(() => void stopped.push(member)),
                onFailure: (error) =>
                  Effect.sync(() => void failed.push({ session_id: member, reason: String(error) })),
              }),
            ),
          { concurrency: "unbounded" },
        )
      }

      // Exactly one notice, to the caller. Every other member's parent is inside
      // the stop set and is being stopped too, so there is nobody waiting there —
      // and notifying them is the only thing that could wake an agent that was
      // just cancelled. The caller is outside the set and awake, because it is
      // the one making this call.
      const info = yield* sessions
        .get(input.target)
        .pipe(Effect.mapError(() => new AgentManagement.AgentNotFound({ session_id: input.target })))
      yield* inbox
        .deliver({
          message: {
            target: input.caller,
            sender: input.target,
            sender_name: info.metadata?.[AgentManagement.METADATA_AGENT_NAME],
            sender_agent: info.agent,
            body: renderTermination(info, stopped.length - 1),
          },
          ops: input.ops,
        })
        .pipe(Effect.ignore)

      return { stopped, failed }
    })

    return Service.of({ create, stop })
  }),
)

function renderTermination(info: Session.Info, descendants: number) {
  const name = info.metadata?.[AgentManagement.METADATA_AGENT_NAME]
  const who = name ? `${name} (${info.agent ?? "agent"})` : (info.agent ?? "agent")
  return [
    `Agent stopped: ${who}`,
    `session_id: ${info.id}`,
    `title: ${info.title}`,
    ...(descendants > 0 ? [`Its ${descendants} descendant Agent(s) were stopped as well.`] : []),
    "Its session and history are intact; it can be resumed with agent_send.",
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    AgentTree.node,
    AgentInbox.node,
    Session.node,
    Agent.node,
    Config.node,
    BackgroundJob.node,
    SessionRunState.node,
    Truncate.node,
    Worktree.node,
    FSUtil.node,
    AppProcess.node,
    path,
  ],
})

export * as AgentLifecycle from "./lifecycle"
