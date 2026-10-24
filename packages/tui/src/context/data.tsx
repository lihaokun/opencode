import type { LocationRef, ReferenceInfo } from "@opencode-ai/sdk/v2"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { createSignal, onCleanup, onMount } from "solid-js"

type LocationData = {
  reference?: ReferenceInfo[]
}

type Data = {
  location: Record<string, LocationData>
}

function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

function locationQuery(ref?: LocationRef) {
  return ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined
}

// Location-scoped data snapshots for autocomplete. The rest of the former
// snapshot layer (agents, models, providers, integrations, commands, skills,
// session projections) fed paths with no TUI consumers and went away with the
// /api rail; autocomplete's reference list is the only live reader. It
// refreshes on the reference.updated event from the shared event stream.
export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<Data>({
      location: {},
    })

    const sdk = useSDK()
    const events = useEvent()

    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef | undefined>(undefined)

    const result = {
      location: {
        default() {
          return defaultLocation
        },
        async refresh(ref?: LocationRef) {
          const response = await sdk.client.v2.location.get({ location: locationQuery(ref) }, { throwOnError: true })
          const location = response.data
          const key = locationKey(location)
          if (!store.location[key]) setStore("location", key, {})
          if (!ref) setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
        },
        reference: {
          list(location?: LocationRef) {
            const current = location ?? defaultLocation()
            return current ? store.location[locationKey(current)]?.reference : undefined
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.reference.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "reference", result.data.data)
          },
        },
      },
    }

    onMount(() => {
      const unsub = events.subscribe((_event, metadata) => {
        if (_event.type !== "reference.updated") return
        void result.location
          .reference.refresh({ directory: metadata.directory, workspaceID: metadata.workspace })
          .catch(() => undefined)
      })
      onCleanup(unsub)

      void result.location
        .refresh()
        .then(() => result.location.reference.refresh())
        .catch((failure) => console.error("Failed to refresh location data", failure))
    })

    return result
  },
})
