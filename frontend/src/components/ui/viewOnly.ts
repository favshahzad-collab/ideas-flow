import { createContext, useContext } from 'react'

/**
 * Whether the screen being shown was given to see but not change. Set by the
 * administration route guard; read by the page header, which says so.
 */
export const ViewOnlyContext = createContext(false)

export function useViewOnly(): boolean {
  return useContext(ViewOnlyContext)
}
