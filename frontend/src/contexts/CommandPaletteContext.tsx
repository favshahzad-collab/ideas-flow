import { useMemo, useState, type ReactNode } from 'react'
import { CommandPaletteContext, type CommandPaletteValue } from './commandPalette'

/**
 * Owns nothing but whether the palette is open. The contextual commands live
 * in the module-level store in `commandPalette.ts`, which the palette itself
 * subscribes to — so a screen registering an action does not re-render the
 * shell around it.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  const value = useMemo<CommandPaletteValue>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen(current => !current),
    }),
    [open],
  )

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
    </CommandPaletteContext.Provider>
  )
}
