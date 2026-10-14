import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Path } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { path } from "@opencode-ai/core/effect/app-node-platform"
import { AppProcess } from "@opencode-ai/core/process"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { AgentEvent } from "@opencode-ai/schema/agent-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AGENT_LIST_TOOL_ID } from "@/tool/agent"
import { Session } from "../session/session"
import { SessionRunState } from "../session/run-state"
import { SessionID, MessageID } from "../session/schema"
import { Truncate } from "../tool/truncate"
import { AgentDelegation } from "./delegation"
import { AgentInbox } from "./inbox"
import { AgentStatusProjection } from "./status"
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
  /**
   * Whether the delegation reports its own outcome back to the caller. Internal
   * — no tool exposes it, and the `agent` tool stays asynchronous either way.
   *
   * `false` is for a caller that needs the result before it can continue, and
   * so waits on the job itself: a command subtask such as /review, which has to
   * summarise what the subagent concluded rather than the confirmation that it
   * started. Leaving the watcher registered as well would give the parent two
   * messages for one delegation, and the automatic one would wake it a second
   * time. Claude Code draws the same line with run_in_background — one
   * delegation mechanism, the call site decides whether it waits.
   */
  notify?: boolean
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
  }) => Effect.Effect<AgentManagement.StopOutcome, AgentManagement.NotAChild | AgentManagement.AgentNotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentLifecycle") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const tree = yield* AgentTree.Service
    const status = yield* AgentStatusProjection.Service
    const inbox = yield* AgentInbox.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const background = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service
    const truncate = yield* Truncate.Service
    const events = yield* EventV2Bridge.Service
    // Captured here so the closures below carry them; prepareWorkdir needs the
    // filesystem, process and worktree services and the returned Interface must
    // have no outstanding requirements.
    const pathSvc = yield* Path.Path
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service

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

    /**
     * Tells a new Agent who it can talk to.
     *
     * Without it a subagent does not know it has a parent at all, and has to
     * call agent_list to guess before it can answer anything. Claude Code hands
     * a subagent the same thing for the same reason.
     *
     * The set is the child's own parent and siblings — the caller, plus the
     * caller's other children. Not the caller's parent and siblings, which from
     * the new child's seat would be its grandparent and its uncles, and have
     * nothing to do with who it can reach.
     *
     * A snapshot, with no statuses. Status would be stale immediately and is
     * the roster's job; this answers a question that does not change. Saying
     * outright that it is a snapshot is what makes it honest when it is
     * incomplete — an Agent named later is not in it.
     *
     * Gated on the recipient's own agent_list permission, not the caller's:
     * denying a subagent agent_list means it should not know about other
     * Agents, and handing it the list by a different route would be a hole in
     * that rather than a nuance of it. Claude Code gates its equivalent the
     * same way, on whether the subagent's own tools include the messaging one.
     */
    const siblingSnapshot = Effect.fn("AgentLifecycle.siblingSnapshot")(function* (input: {
      caller: Session.Info
      child: SessionID
      subagent: Agent.Info
      permission: PermissionV1.Ruleset
    }) {
      // Both halves, the way session/tools.ts merges them. The session ruleset
      // carries what was derived for this run; a rule a user wrote lives on the
      // agent definition and is not in there — deriveSubagentSessionPermission
      // deliberately leaves the subagent's own permissions to the subagent.
      // Checking only the session half missed exactly the case worth catching.
      const ruleset = Permission.merge(input.subagent.permission, input.permission)
      if (Permission.evaluate(AGENT_LIST_TOOL_ID, "*", ruleset).action === "deny") return undefined

      const depth = yield* tree.callerDepth(input.caller.id).pipe(Effect.orElseSucceed(() => 0))
      const siblings = (yield* tree.children(input.caller.id, depth + 1)).filter(
        (item) => item.session_id !== input.child,
      )
      // Running only. Listing every sibling the parent had ever started is what
      // the old heading promised -- everyone reachable -- and agent_send
      // reaches anyone at all by session_id, so that promise had no bound: on
      // one real session this came to 132 rows, five times the size of the task
      // the Agent was being given. What a new Agent needs is who is working
      // beside it; enumerating is agent_list's job.
      const live = yield* Effect.forEach(siblings, (item) =>
        status.of(item.session_id).pipe(Effect.map((state) => (state === "running" ? item : undefined))),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))

      // Names and titles come from the model and go into lines this writes, so
      // they are encoded the same way a message header's fields are — a newline
      // in one would otherwise add a row of its own to a list the reader is
      // meant to trust. A title already reads `<description> (@<type>
      // subagent)`, so it carries the agent type and no separate column does.
      const raw = input.caller.metadata?.[AgentManagement.METADATA_AGENT_NAME]
      const callerName = raw === undefined ? undefined : `${AgentInbox.escapeField(raw)}  `
      const parent = `Your parent: ${input.caller.id}  ${callerName ?? ""}— ${AgentInbox.escapeField(input.caller.title)}`

      // Newest first, then capped: a parent that fans out widely would
      // otherwise trade one unbounded list for a shorter unbounded list.
      const ordered = live.toSorted((a, b) => b.time_created - a.time_created)
      const shown = ordered.slice(0, AgentManagement.ROSTER_MAX_ROWS)
      const omitted = ordered.length - shown.length
      // No relation column: the parent has its own line above and everything
      // below it is a sibling by construction, so repeating a constant per row
      // carries nothing.
      const rows = shown.map((item) => {
        const name = item.name ? `${AgentInbox.escapeField(item.name)}  ` : ""
        return `  ${item.session_id}  ${name}— ${AgentInbox.escapeField(item.title)}`
      })

      return [
        parent,
        ...(rows.length > 0
          ? [
              "",
              "Working alongside you right now:",
              ...rows,
              ...(omitted > 0 ? [`  ${omitted} more are running.`] : []),
            ]
          : []),
        "",
        // Two facts and no tool directions. The list is not everyone the Agent
        // can reach, and it was taken at the moment the Agent started; both are
        // worth saying so the list is not mistaken for either. Which tool gives
        // the current picture is already in the tool descriptions.
        "Not everyone you can reach, and not current past this moment.",
      ].join("\n")
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
     * Starts the initial delegation as a background job. The job exists for
     * agent_list (status), agent_stop (cancel) and the command-subtask path,
     * which waits on it; it does not report the outcome. That is done by
     * SessionPrompt at the end of every run of the child — this first one and
     * each one agent_send starts later — from the notify flag persisted on the
     * child session, so the first run and the later ones go the same way.
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
      notify: boolean
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

      // A client watching the event stream cannot otherwise tell a finished tree
      // from one whose result is still on its way to the caller: the subagent
      // goes idle either way, and nothing else marks the difference. Published
      // here, synchronously, because the caller may go idle the moment this tool
      // returns and a client must already see the debt by then. The matching
      // `settled` comes from SessionPrompt once the run-end notice has been
      // delivered. Only for delegations that report back on their own — a
      // caller awaiting the result itself never leaves that gap, and the pair
      // would never close.
      if (input.notify) {
        yield* events.publish(AgentEvent.Delegation, {
          sessionID: input.session.id,
          caller: input.caller,
          status: "started",
        })
      }

      // Job id is the child SessionID, keeping the existing identity convention.
      yield* background.start({
        id: input.session.id,
        type: "agent",
        title: input.description,
        metadata: { parentSessionId: input.caller, sessionId: input.session.id, model: input.model },
        run,
      })
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
      const model = next.model ? { providerID: next.model.providerID, modelID: next.model.modelID } : input.model
      const variant = next.model ? undefined : input.variant

      const workdir = yield* AgentWorkdir.prepareWorkdir({
        cwd: input.cwd,
        parentWorkdir: parent.metadata?.[AgentManagement.METADATA_AGENT_WORKDIR],
      }).pipe(
        Effect.map((result) => ({ ...result, enforced: false as const })),
        Effect.provideService(Path.Path, pathSvc),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(AppProcess.Service, appProcess),
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
          [AgentManagement.METADATA_AGENT_DESCRIPTION]: input.description,
          // Persisted rather than carried by the delegation: the parent is told
          // at the end of every run, and runs after the first are driven by
          // agent_send, which never sees this call's arguments.
          [AgentManagement.METADATA_AGENT_NOTIFY]: input.notify ?? true,
        },
      })

      const neighbours = yield* siblingSnapshot({
        caller: parent,
        child: session.id,
        subagent: next,
        permission: childPermission,
      })

      // Keeps the parts structure: resolvePromptParts expands @file references
      // into attachment parts, and flattening to a string drops them.
      const resolved = yield* input.ops.resolvePromptParts(input.prompt)
      const parts = [
        { type: "text" as const, text: workdirInstruction(workdir, parent.directory) },
        ...(neighbours ? [{ type: "text" as const, text: neighbours }] : []),
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
        notify: input.notify ?? true,
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
            kind: "agent",
            message: {
              target: input.caller,
              sender: input.target,
              sender_name: info.metadata?.[AgentManagement.METADATA_AGENT_NAME],
              sender_agent: info.agent,
              body: renderTermination(info, stopped.length - 1),
            },
          },
          ops: input.ops,
        })
        .pipe(Effect.ignore)

      return { stopped, failed }
    })

    return Service.of({ create, stop })
  }),
)

// `cancelled`, not `stopped`: one word for the state everywhere, matching the
// job status and what agent_list reports.
//
// Name, agent type and title all originate with the model, and all three land
// in a system-written line, so they go through the same escaping as a message
// header — see AgentInbox.escapeField.
function renderTermination(info: Session.Info, descendants: number) {
  const raw = info.metadata?.[AgentManagement.METADATA_AGENT_NAME]
  const name = raw === undefined ? undefined : AgentInbox.escapeField(raw)
  const agent = AgentInbox.escapeField(info.agent ?? "agent")
  const who = name ? `${name} (${agent})` : agent
  return [
    `Agent cancelled: ${who}`,
    `session_id: ${info.id}`,
    `title: ${AgentInbox.escapeField(info.title)}`,
    ...(descendants > 0 ? [`Its ${descendants} descendant Agent(s) were stopped as well.`] : []),
    "Its session and history are intact; it can be resumed with agent_send.",
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    AgentTree.node,
    AgentStatusProjection.node,
    AgentInbox.node,
    Session.node,
    Agent.node,
    Config.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    SessionRunState.node,
    Truncate.node,
    FSUtil.node,
    AppProcess.node,
    path,
  ],
})

export * as AgentLifecycle from "./lifecycle"
