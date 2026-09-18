import * as Tool from "./tool"
import { ToolJsonSchema } from "./json-schema"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@/config/config"
import { AgentLifecycle } from "@/agent-management/lifecycle"
import { AgentInbox } from "@/agent-management/inbox"
import { AgentStatusProjection } from "@/agent-management/status"
import { AgentTree } from "@/agent-management/tree"
import { AgentManagement } from "@/agent-management/schema"
import { MessageV2 } from "../session/message-v2"
import { Session } from "@/session/session"

export const AGENT_TOOL_ID = "agent"
export const AGENT_LIST_TOOL_ID = "agent_list"
export const AGENT_SEND_TOOL_ID = "agent_send"
export const AGENT_STOP_TOOL_ID = "agent_stop"

export const AGENT_TOOL_IDS = [AGENT_TOOL_ID, AGENT_LIST_TOOL_ID, AGENT_SEND_TOOL_ID, AGENT_STOP_TOOL_ID]

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 word) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  name: Schema.optional(
    Schema.String.annotate({
      description:
        "Optional short name for this Agent, used to address it later with agent_send or agent_stop. Must not start with 'ses'. Names are a convenience: they are not guaranteed unique, and an ambiguous name is refused rather than guessed.",
    }),
  ),
  cwd: Schema.optional(
    Schema.String.annotate({
      description:
        "Working directory for this Agent. When omitted a separate working directory is prepared for it automatically.",
    }),
  ),
})

const SendParameters = Schema.Struct({
  target: Schema.String.annotate({
    description: "The session_id of the Agent to message, or the name of one of your neighbours",
  }),
  message: Schema.String.annotate({ description: "The message to deliver" }),
})

const StopParameters = Schema.Struct({
  target: Schema.String.annotate({
    description: "The session_id of the Agent to stop, or the name of one of your direct children",
  }),
})

const ListParameters = Schema.Struct({})

type AgentMeta = {
  parentSessionId?: string
  sessionId?: string
  model?: { providerID: string; modelID: string }
}
type ListMeta = { count?: number }
type SendMeta = { target?: string }
type StopMeta = { stopped?: number; failed?: number }

const AGENT_DESCRIPTION = [
  "- Launches a subagent to handle a complex, multi-step task",
  "- Always asynchronous: this returns once the subagent has started, not when it finishes. Its result arrives later as a message in your conversation",
  "- Do not sleep, poll, or message a subagent to ask whether it is done — you will be told",
  "- Launch several in one response when the work is genuinely independent",
  "- Each subagent gets its own working directory and is told to use it, so parallel work does not collide. This is a convention, not a sandbox: it can still reach the rest of the project by absolute path. Pass `cwd` to place it somewhere specific instead",
  "- The returned `session_id` always works as a target for agent_send and agent_stop",
  "- `name` is optional and shorter to use, but is not guaranteed unique; if two subagents share one, that name is refused and you must use the session_id",
  "- Nesting is bounded: a subagent deep enough in the tree is not offered this tool at all",
].join("\n")

const LIST_DESCRIPTION = [
  "- Lists the agents you can address: yourself, your parent, your direct children and your siblings",
  "- Does not list grandchildren, or agents belonging to an unrelated conversation",
  "- Every row carries a session_id, which always works as a target; a row may also carry a name, which is shorter but only unique by convention — when two rows share one, use the session_id",
  "- Status is `running` or `idle`, read at this instant. It is a snapshot, not a promise: one shown as running may finish immediately after",
  "- Status never says how an agent finished; that arrives as a message",
].join("\n")

const SEND_DESCRIPTION = [
  "- Sends a message to another agent; also how you resume one that has gone idle, including one that was stopped",
  "- This is a message, not a call. The recipient does not reply automatically and this does not wait for it",
  "- What comes back means the message was accepted for delivery — not that it was processed, and not that an answer is coming",
  "- If you need an answer, ask for it in the message and carry on. The recipient replies by calling agent_send itself. Do not follow up asking where the result is",
  "- Reaches your parent, children and siblings by name or session_id, and any agent at all by session_id",
  "- The recipient acts under its own permissions: this is not a way to have work done that you are not allowed to do yourself",
  "- Your identity is attached automatically and cannot be set from here",
].join("\n")

const STOP_DESCRIPTION = [
  "- Stops an agent you launched, along with everything it launched in turn",
  "- Only your own direct children can be named as the target; the cascade to their descendants follows automatically",
  "- Nothing is deleted. The session and its history survive, so a stopped agent can be picked up again with agent_send",
  "- The result says which agents a stop was performed on. That is not a claim that each was busy — stopping an idle one is harmless, reported the same way, and repeating the call is safe",
].join("\n")

/** Renders a typed failure as the tool's text result, keeping the metadata shape. */
function failed<M extends { [key: string]: unknown }>(title: string, output: string): Tool.ExecuteResult<M> {
  return { title, metadata: {} as M, output }
}

function requireOps(ctx: Tool.Context) {
  const ops = ctx.extra?.promptOps as AgentManagement.AgentPromptOps | undefined
  return ops
    ? Effect.succeed(ops)
    : Effect.fail(new Error("The agent tools require promptOps in ctx.extra"))
}

export const AgentTool = Tool.define(
  AGENT_TOOL_ID,
  Effect.gen(function* () {
    const lifecycle = yield* AgentLifecycle.Service
    const database = yield* Database.Service

    const run = Effect.fn("AgentTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const ops = yield* requireOps(ctx)

      // Kept, not removed. This is the only place a deny is evaluated: `deny`
      // refuses, `allow` passes, and only `ask` reaches the UI. The default is
      // allow, so spawning an Agent does not prompt, but a rule naming a
      // subagent type still does what it says.
      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: AGENT_TOOL_ID,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: { subagent_type: params.subagent_type },
        })
      }

      // The variant lives on the message, not the session, and the model to
      // inherit is the one this very turn is using rather than whatever the
      // session currently points at.
      const message = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (message.info.role !== "assistant") {
        return yield* Effect.fail(new Error("agent must be called from an assistant message"))
      }

      const info = yield* lifecycle
        .create({
          caller: ctx.sessionID,
          name: params.name,
          subagent_type: params.subagent_type,
          description: params.description,
          prompt: params.prompt,
          cwd: params.cwd,
          model: { providerID: message.info.providerID, modelID: message.info.modelID },
          variant: message.info.variant,
          ops,
          // Passed per call through ctx.extra, alongside promptOps and
          // bypassAgentCheck, which is why it cannot reach the tool's schema or
          // leak into the child's execution. Set by the command-subtask path,
          // which waits on the job itself and would otherwise get both the
          // automatic notice and its own summary.
          notify: ctx.extra?.notifyOnFinish !== false,
        })
        .pipe(Effect.catch((error) => Effect.succeed(error)))

      if ("_tag" in info) return failed<AgentMeta>(params.description, info.message)

      const metadata: AgentMeta = {
        parentSessionId: ctx.sessionID,
        sessionId: info.session_id,
        // The child's resolved model, not the parent's inherited candidate — a
        // subagent definition may pin a different one, and the card would name
        // the wrong model.
        model: info.model,
      }
      yield* ctx.metadata({ title: params.description, metadata })

      return {
        title: params.description,
        metadata,
        output: [
          `Started ${info.agent_type} agent${info.name ? ` "${info.name}"` : ""}.`,
          `session_id: ${info.session_id}`,
          ...(info.name ? [`name: ${info.name}`] : []),
          `working directory: ${info.workdir.path}`,
          "",
          // Not "running": the job may not have started yet, and claiming a
          // status here would contradict agent_list a moment later.
          "It is running in the background. Its result will arrive as a message when it finishes.",
          "Use agent_list for its current status.",
        ].join("\n"),
      }
    })

    return {
      description: AGENT_DESCRIPTION,
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

export const AgentListTool = Tool.define(
  AGENT_LIST_TOOL_ID,
  Effect.gen(function* () {
    const tree = yield* AgentTree.Service
    const projection = yield* AgentStatusProjection.Service

    const run = Effect.fn("AgentListTool.execute")(function* (_params: unknown, ctx: Tool.Context) {
      const result = yield* tree
        .neighborhood(ctx.sessionID)
        .pipe(Effect.catch((error) => Effect.succeed(error)))
      if ("_tag" in result) return failed<ListMeta>("agents", result.message)

      // Status is assembled here, not in the tree: it is a different observed
      // domain, and the tree cannot answer it.
      const rows = yield* Effect.forEach(
        result.members,
        (member) =>
          projection.of(member.session_id).pipe(
            Effect.map((status) => ({
              session_id: member.session_id,
              // name, agent_type and title all originate with the model and
              // land in a tab-separated table read by another model. A tab
              // shifts the columns and a newline forges an entire row --
              // session_id included, which is the field a reader routes on. The
              // same encoding the message header uses, for the same reason.
              name: AgentInbox.escapeField(member.name ?? ""),
              agent_type: AgentInbox.escapeField(member.agent_type ?? ""),
              relation: member.relation,
              status,
              title: AgentInbox.escapeField(member.title),
              workdir: member.workdir?.path ?? "",
            })),
          ),
        { concurrency: "unbounded" },
      )

      const header = ["session_id", "name", "agent_type", "relation", "status", "title", "workdir"]
      const lines = [header.join("\t"), ...rows.map((row) => header.map((key) => (row as never)[key]).join("\t"))]
      return {
        title: "agents",
        metadata: { count: rows.length } satisfies ListMeta,
        output: [
          ...lines,
          "",
          "session_id always works as a target. A name is shorter but is not guaranteed unique; when two rows share one, use the session_id.",
        ].join("\n"),
      }
    })

    return {
      description: LIST_DESCRIPTION,
      parameters: ListParameters,
      jsonSchema: ToolJsonSchema.fromSchema(ListParameters),
      execute: (params: Schema.Schema.Type<typeof ListParameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

export const AgentSendTool = Tool.define(
  AGENT_SEND_TOOL_ID,
  Effect.gen(function* () {
    const tree = yield* AgentTree.Service
    const inbox = yield* AgentInbox.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("AgentSendTool.execute")(function* (
      params: Schema.Schema.Type<typeof SendParameters>,
      ctx: Tool.Context,
    ) {
      const ops = yield* requireOps(ctx)
      const self = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)

      const target = yield* tree
        .resolveTarget({ caller: ctx.sessionID, value: params.target, scope: "neighbor" })
        .pipe(Effect.catch((error) => Effect.succeed(error)))
      if (typeof target !== "string") return failed<SendMeta>(params.target, target.message)

      const accepted = yield* inbox
        .deliver({
          message: {
            target,
            // Taken from the execution context, never from the arguments, so a
            // model cannot claim to be someone else.
            sender: ctx.sessionID,
            sender_name: self.metadata?.[AgentManagement.METADATA_AGENT_NAME],
            sender_agent: self.agent ?? ctx.agent,
            body: params.message,
          },
          ops,
        })
        .pipe(Effect.catch((error) => Effect.succeed(error)))

      if ("_tag" in accepted) return failed<SendMeta>(params.target, accepted.message)

      const sendMeta: SendMeta = { target: accepted.target }
      return {
        title: params.target,
        metadata: sendMeta,
        output: [
          `Accepted for ${accepted.target}.`,
          // Spelled out because a model that reads this as a call will spend its
          // next turn asking where the answer is.
          "This is a one-way message: the target will not reply automatically, this call did not wait for it, and delivery is not guaranteed to have been processed.",
          "If you need a response, wait for the target to send one back.",
        ].join("\n"),
      }
    })

    return {
      description: SEND_DESCRIPTION,
      parameters: SendParameters,
      jsonSchema: ToolJsonSchema.fromSchema(SendParameters),
      execute: (params: Schema.Schema.Type<typeof SendParameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

export const AgentStopTool = Tool.define(
  AGENT_STOP_TOOL_ID,
  Effect.gen(function* () {
    const tree = yield* AgentTree.Service
    const lifecycle = yield* AgentLifecycle.Service

    const run = Effect.fn("AgentStopTool.execute")(function* (
      params: Schema.Schema.Type<typeof StopParameters>,
      ctx: Tool.Context,
    ) {
      const ops = yield* requireOps(ctx)

      const target = yield* tree
        .resolveTarget({ caller: ctx.sessionID, value: params.target, scope: "child" })
        .pipe(Effect.catch((error) => Effect.succeed(error)))
      if (typeof target !== "string") return failed<StopMeta>(params.target, target.message)

      const outcome = yield* lifecycle
        .stop({ caller: ctx.sessionID, target, ops })
        .pipe(Effect.catch((error) => Effect.succeed(error)))
      if ("_tag" in outcome) return failed<StopMeta>(params.target, outcome.message)

      const stopped = outcome.stopped
      const problems = outcome.failed
      return {
        title: params.target,
        metadata: { stopped: stopped.length, failed: problems.length } satisfies StopMeta,
        output: [
          `Stopped ${stopped.length} Agent(s): ${stopped.join(", ")}`,
          // "Stopped" means a stop was performed. Whether any of them was
          // running at the time is not something this can know.
          "A stop was performed on each; that does not mean each was running at the time.",
          ...(problems.length > 0
            ? ["", "Failed:", ...problems.map((item) => `- ${item.session_id}: ${item.reason}`)]
            : []),
          "",
          "Their sessions and history are intact and can be resumed with agent_send.",
        ].join("\n"),
      }
    })

    return {
      description: STOP_DESCRIPTION,
      parameters: StopParameters,
      jsonSchema: ToolJsonSchema.fromSchema(StopParameters),
      execute: (params: Schema.Schema.Type<typeof StopParameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

/**
 * Which Agent tools a session may see, by depth.
 *
 * Computed where the tool list is built, from the session — not from
 * Tool.Context, which does not exist until a tool actually runs, by which point
 * the schema the model sees has already been sent.
 */
export const visibleAgentTools = Effect.fn("AgentTools.visible")(function* (sessionID: Parameters<AgentTree.Interface["callerDepth"]>[0]) {
  const tree = yield* AgentTree.Service
  const config = yield* Config.Service
  const cfg = yield* config.get()
  const limit = cfg.subagent_depth ?? AgentLifecycle.DEFAULT_SUBAGENT_DEPTH
  const depth = yield* tree.callerDepth(sessionID).pipe(Effect.orElseSucceed(() => 0))
  // At the limit an Agent can never spawn, so it can never have a child to stop;
  // both tools are withdrawn. Parent and siblings stay addressable regardless of
  // depth, so list and send remain. The test is depth, not whether it currently
  // has children — otherwise agent_stop would blink in and out.
  return depth >= limit
    ? [AGENT_LIST_TOOL_ID, AGENT_SEND_TOOL_ID]
    : [AGENT_TOOL_ID, AGENT_LIST_TOOL_ID, AGENT_SEND_TOOL_ID, AGENT_STOP_TOOL_ID]
})
