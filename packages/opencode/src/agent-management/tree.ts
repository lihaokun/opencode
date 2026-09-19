import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context } from "effect"
import { Session } from "../session/session"
import { SessionID } from "../session/schema"
import { AgentManagement } from "./schema"

export interface Interface {
  /** The caller's parent, direct children and siblings, plus the caller itself. */
  readonly neighborhood: (
    caller: SessionID,
  ) => Effect.Effect<AgentManagement.AgentNeighborhood, AgentManagement.AgentNotFound>
  readonly children: (id: SessionID, depth: number) => Effect.Effect<AgentManagement.AgentSkeleton[]>
  /** Descendant closure of `id`, excluding `id`. Drives the stop cascade only. */
  readonly descendants: (id: SessionID, baseDepth: number) => Effect.Effect<AgentManagement.AgentSkeleton[]>
  readonly isChild: (caller: SessionID, target: SessionID) => Effect.Effect<boolean, AgentManagement.AgentNotFound>
  readonly resolveTarget: (input: {
    caller: SessionID
    value: string
    scope: "neighbor" | "child"
  }) => Effect.Effect<SessionID, AgentManagement.TargetNotResolved | AgentManagement.AgentNotFound>
  readonly callerDepth: (id: SessionID) => Effect.Effect<number, AgentManagement.AgentNotFound>
  readonly root: (id: SessionID) => Effect.Effect<SessionID, AgentManagement.AgentNotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentTree") {}

const RELATION_ORDER: Record<AgentManagement.AgentRelation, number> = {
  self: 0,
  parent: 1,
  child: 2,
  sibling: 3,
}

export function toSkeleton(
  session: Session.Info,
  relation: AgentManagement.AgentRelation,
  depth: number,
): AgentManagement.AgentSkeleton {
  const metadata = session.metadata
  return {
    session_id: session.id,
    parent_id: session.parentID,
    name: metadata?.[AgentManagement.METADATA_AGENT_NAME],
    agent_type: session.agent,
    title: session.title,
    depth,
    relation,
    time_created: session.time.created,
    // Never Session.Info.directory: that is the real instance execution
    // directory, and passing it off as the suggested workdir would imply the
    // runtime cwd had been switched.
    workdir: metadata?.[AgentManagement.METADATA_AGENT_WORKDIR],
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const get = Effect.fn("AgentTree.get")(function* (id: SessionID) {
      return yield* sessions.get(id).pipe(Effect.mapError(() => new AgentManagement.AgentNotFound({ session_id: id })))
    })

    const callerDepth = Effect.fn("AgentTree.callerDepth")(function* (id: SessionID) {
      let depth = 0
      let current = yield* get(id)
      // Terminates: the parentID chain is acyclic and bounded (assumption H2),
      // and every step moves strictly one level up.
      while (current.parentID) {
        depth += 1
        current = yield* get(current.parentID)
      }
      return depth
    })

    const root = Effect.fn("AgentTree.root")(function* (id: SessionID) {
      let current = yield* get(id)
      while (current.parentID) {
        current = yield* get(current.parentID)
      }
      return current.id
    })

    const children = Effect.fn("AgentTree.children")(function* (id: SessionID, depth: number) {
      const rows = yield* sessions.children(id)
      return rows.map((row) => toSkeleton(row, "child", depth))
    })

    const descendants = Effect.fn("AgentTree.descendants")(function* (id: SessionID, baseDepth: number) {
      const acc: AgentManagement.AgentSkeleton[] = []
      const seen = new Set<SessionID>([id])
      let frontier = [id]
      let level = baseDepth
      // Terminates: every member added to `acc` is newly added to `seen`, which
      // only grows and is bounded by the number of Sessions. The dedupe is
      // defensive — H2 already rules out cycles.
      while (frontier.length > 0) {
        level += 1
        const next: SessionID[] = []
        for (const member of frontier) {
          for (const child of yield* children(member, level)) {
            if (seen.has(child.session_id)) continue
            seen.add(child.session_id)
            acc.push(child)
            next.push(child.session_id)
          }
        }
        frontier = next
      }
      return acc
    })

    const neighborhood = Effect.fn("AgentTree.neighborhood")(function* (caller: SessionID) {
      const self = yield* get(caller)
      const depth = yield* callerDepth(caller)

      // A child's parentID is bound at creation and never changes (H2), and
      // Session.remove deletes children with their parent, so this lookup does
      // not fail in practice; if it does the store is inconsistent and
      // AgentNotFound is the honest answer.
      const parent = self.parentID ? yield* get(self.parentID) : undefined
      const siblings = self.parentID
        ? (yield* sessions.children(self.parentID)).filter((row) => row.id !== caller)
        : []

      const members = [
        toSkeleton(self, "self", depth),
        ...(parent ? [toSkeleton(parent, "parent", depth - 1)] : []),
        ...(yield* children(caller, depth + 1)),
        ...siblings.map((row) => toSkeleton(row, "sibling", depth)),
      ].toSorted(
        (a, b) =>
          RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation] ||
          a.time_created - b.time_created ||
          // session_id breaks millisecond ties. Without it siblings spawned in
          // the same batch reorder between renders, which reads to a model like
          // the roster changed.
          (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0),
      )

      return { caller, members }
    })

    const isChild = Effect.fn("AgentTree.isChild")(function* (caller: SessionID, target: SessionID) {
      return (yield* get(target)).parentID === caller
    })

    const resolveTarget = Effect.fn("AgentTree.resolveTarget")(function* (input: {
      caller: SessionID
      value: string
      scope: "neighbor" | "child"
    }) {
      // A SessionID is used as given: existence is checked by the inbox, and the
      // direct-child constraint by the stop planner. Name lookup never widens
      // what a tool could already address.
      if (input.value.startsWith(AgentManagement.SESSION_ID_PREFIX)) return SessionID.make(input.value)

      const members = (yield* neighborhood(input.caller)).members
      const candidates =
        input.scope === "child"
          ? members.filter((member) => member.relation === "child")
          : // Excluding self matters: otherwise an Agent using its own name
            // resolves to itself and gets rejected as a self-delivery, which is
            // the right refusal with the wrong explanation.
            members.filter((member) => member.relation !== "self")

      const matches = candidates.filter((member) => member.name === input.value)
      if (matches.length === 1) return matches[0].session_id
      // Multiple matches is an ordinary outcome — instance names are weak
      // aliases with no uniqueness guarantee — so hand back every candidate and
      // refuse rather than picking one.
      return yield* new AgentManagement.TargetNotResolved({
        value: input.value,
        matches: matches.map((member) => member.session_id),
      })
    })

    return Service.of({ neighborhood, children, descendants, isChild, resolveTarget, callerDepth, root })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node] })

export * as AgentTree from "./tree"
