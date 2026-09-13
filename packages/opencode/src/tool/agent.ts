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

const AgentParameters = Schema.Struct({
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
  "Launch a new Agent to handle a complex, multi-step task.",
  "",
  "The Agent runs asynchronously: this call returns as soon as it has started, and its result arrives as a message when it finishes. Do not sleep or poll waiting for it.",
  "It gets its own working directory, stated in its initial instructions, so several Agents can work without fighting over the same files.",
  "",
  "Use agent_list to see who is running, agent_send to give an existing Agent more work, and agent_stop to stop one you spawned.",
].join("\n")

const LIST_DESCRIPTION = [
  "List the Agents you can address: yourself, your parent, your direct children and your siblings.",
  "Each row carries a session_id, which always works as a target, and may carry a name, which is shorter but only unique by convention.",
  "Status is a snapshot taken now — it is not a promise about what happens next.",
].join("\n")

const SEND_DESCRIPTION = [
  "Send a message to another Agent.",
  "",
  "This is one-way. The target does not reply automatically, this call does not wait for it, and delivery is accepted rather than guaranteed.",
  "If you need an answer, wait for the target to send one back with agent_send of its own.",
].join("\n")

const STOP_DESCRIPTION = [
  "Stop an Agent you spawned, along with everything it spawned in turn.",
  "",
  "Sessions and history are kept, so a stopped Agent can be resumed later with agent_send.",
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
      params: Schema.Schema.Type<typeof AgentParameters>,
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
      parameters: AgentParameters,
      jsonSchema: ToolJsonSchema.fromSchema(AgentParameters),
      execute: (params: Schema.Schema.Type<typeof AgentParameters>, ctx: Tool.Context) =>
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
              name: member.name ?? "",
              agent_type: member.agent_type ?? "",
              relation: member.relation,
              status,
              title: member.title,
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
