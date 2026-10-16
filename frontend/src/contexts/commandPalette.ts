import { createContext, useContext, useEffect } from 'react'

/**
 * The context object, the contextual-command store and their hooks, kept out
 * of the provider's `.tsx`. A file that exports both a component and
 * something else loses fast refresh, which is why every context here is
 * split the same way.
 */

export type CommandGroup = 'actions' | 'documents' | 'goto'

export interface Command {
  id: string
  group: CommandGroup
  label: string
  /** The second line — what running this will do, or where it goes. */
  hint?: string
  /** Rendered right-aligned in mono. Display only; the binding lives elsewhere. */
  shortcut?: string
  run: () => void
}

export interface CommandPaletteValue {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const CommandPaletteContext = createContext<CommandPaletteValue | null>(null)

export function useCommandPalette(): CommandPaletteValue {
  const value = useContext(CommandPaletteContext)
  if (!value) {
    throw new Error('useCommandPalette must be used inside CommandPaletteProvider')
  }
  return value
}

/* ------------------------------------------------------------------ *
 * Contextual commands
 *
 * A plain external store rather than React state. Screens register from an
 * effect on mount, and writing to an outside store from an effect is what
 * effects are for — holding the same map in provider state would mean every
 * screen calling setState during its own mount commit, re-rendering the whole
 * shell to add three rows nobody has opened the palette to see yet.
 * ------------------------------------------------------------------ */

const registry = new Map<string, Command[]>()
const listeners = new Set<() => void>()

/** Recomputed on write, so `getSnapshot` can return a stable reference. */
let snapshot: Command[] = []

function publish() {
  snapshot = [...registry.values()].flat()
  for (const listener of listeners) listener()
}

export function subscribeToCommands(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getCommandsSnapshot(): Command[] {
  return snapshot
}

/**
 * Lets a screen contribute actions for as long as it is mounted — the
 * palette's ACTIONS group is contextual, so "Sign & approve" exists only
 * where there is a document to approve.
 *
 * State what the commands depend on in `deps`, exactly as for an effect;
 * `commands` is a fresh array every render and cannot be a dependency.
 */
export function useRegisterCommands(
  ownerId: string,
  commands: Command[],
  deps: unknown[],
) {
  useEffect(() => {
    registry.set(ownerId, commands)
    publish()
    return () => {
      registry.delete(ownerId)
      publish()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, ...deps])
}
