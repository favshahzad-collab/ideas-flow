import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPaletteProvider } from './CommandPaletteContext'
import {
  getCommandsSnapshot,
  subscribeToCommands,
  useCommandPalette,
  useRegisterCommands,
  type Command,
} from './commandPalette'

/**
 * Two small pieces of state that the whole command bar hangs off.
 *
 * The provider owns nothing but "is it open" - and the only way to get that
 * wrong is to have it disagree with itself, so that ⌘K leaves the palette
 * open when it should have closed.
 *
 * The registry is the riskier half. Screens push their own actions into it
 * from an effect - "Sign & approve", "Request revision" - and those actions
 * close over that screen's state. A registration that outlives the screen is
 * a row in the palette that raises a modal belonging to a document nobody is
 * looking at any more, so the removal on unmount is asserted here directly
 * against the store rather than through anything that renders it.
 */

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 'doc:sign',
    group: 'actions',
    label: 'Sign & approve this document',
    hint: 'Warehouse lease extension',
    run: () => {},
    ...overrides,
  }
}

const registeredIds = () => getCommandsSnapshot().map(command => command.id)

/** A screen that contributes actions for exactly as long as it is mounted. */
function Screen({
  owner,
  commands,
  deps = [],
}: {
  owner: string
  commands: Command[]
  deps?: unknown[]
}) {
  useRegisterCommands(owner, commands, deps)
  return <p>{owner} is open</p>
}

describe('CommandPaletteProvider', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CommandPaletteProvider>{children}</CommandPaletteProvider>
  )

  it('starts closed', () => {
    const { result } = renderHook(() => useCommandPalette(), { wrapper })

    // A palette that were open on first paint would swallow the first
    // keystroke of every page load.
    expect(result.current.open).toBe(false)
  })

  it('opens and closes when asked', () => {
    const { result } = renderHook(() => useCommandPalette(), { wrapper })

    act(() => result.current.setOpen(true))
    expect(result.current.open).toBe(true)

    act(() => result.current.setOpen(false))
    expect(result.current.open).toBe(false)
  })

  it('toggles from whatever it currently is, even twice in one tick', () => {
    const { result } = renderHook(() => useCommandPalette(), { wrapper })

    act(() => {
      result.current.toggle()
      result.current.toggle()
    })

    // Two handlers can answer one ⌘K - the document listener and a trigger
    // button both fire in the same batch. A toggle written as `setOpen(!open)`
    // reads a stale `open` for the second call and leaves the palette open
    // when the person asked for it to be gone.
    expect(result.current.open).toBe(false)

    // ...and this is what stops that from being satisfied by a `toggle` that
    // does nothing at all, which lands on `false` just as convincingly.
    act(() => result.current.toggle())
    expect(result.current.open).toBe(true)
  })

  it('refuses to work outside its provider rather than pretending to', () => {
    // React logs the throw as well; silencing it keeps a deliberate failure
    // from reading like a broken test run.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => renderHook(() => useCommandPalette())).toThrow(/CommandPaletteProvider/)

    errors.mockRestore()
  })
})

describe('useRegisterCommands', () => {
  beforeEach(() => {
    // The registry is a module-level store shared by every test in the file.
    // A registration that leaked out of the previous one is a phantom row in
    // this one's `toEqual`, and the failure it causes points at the wrong test.
    expect(registeredIds()).toEqual([])
  })

  it('adds a screen’s actions while it is on screen', () => {
    render(<Screen owner="document-detail" commands={[makeCommand()]} />)

    expect(registeredIds()).toEqual(['doc:sign'])
  })

  it('takes them away again when the screen unmounts', () => {
    const { unmount } = render(<Screen owner="document-detail" commands={[makeCommand()]} />)
    expect(registeredIds()).toEqual(['doc:sign'])

    unmount()

    // This is the whole hazard: "Sign & approve" left in the palette after
    // the document was closed still opens the signing modal, against state
    // belonging to a screen that no longer exists.
    expect(registeredIds()).toEqual([])
  })

  it('leaves the other screens’ actions alone when one of them closes', () => {
    const { unmount } = render(<Screen owner="doc-detail" commands={[makeCommand()]} />)
    render(
      <Screen
        owner="submit"
        commands={[makeCommand({ id: 'submit:save-draft', label: 'Save draft' })]}
      />,
    )

    // Both really are in there first - otherwise a registry that had quietly
    // dropped the second screen would satisfy the assertion below as well,
    // for the wrong reason. Order is asserted too: the palette renders the
    // ACTIONS group in registration order, so it is what somebody sees.
    expect(registeredIds()).toEqual(['doc:sign', 'submit:save-draft'])

    unmount()

    // Keyed by owner rather than kept in one list, so an unmount cannot take
    // a neighbour's actions down with it.
    expect(registeredIds()).toEqual(['submit:save-draft'])
  })

  it('moves the registration when the same screen swaps to another document', () => {
    const { rerender } = render(
      <Screen owner="doc:one" commands={[makeCommand({ id: 'doc:one:sign' })]} />,
    )

    rerender(<Screen owner="doc:two" commands={[makeCommand({ id: 'doc:two:sign' })]} />)

    // Clicking through from one document to the next remounts nothing - the
    // same component re-registers under a new key. The old key has to go with
    // it, or the palette offers "Sign & approve" twice, one of them against
    // the document that was left behind.
    expect(registeredIds()).toEqual(['doc:two:sign'])
  })

  it('replaces a screen’s own actions rather than doubling them up', () => {
    const first = [makeCommand()]
    const second = [makeCommand()]
    const { rerender } = render(
      <Screen owner="document-detail" commands={first} deps={['v1']} />,
    )

    rerender(<Screen owner="document-detail" commands={second} deps={['v2']} />)

    // Re-registering happens on every deps change - a new document id, a
    // permission that just resolved. Appending instead of replacing would
    // show the same row twice and grow the palette on every navigation.
    expect(registeredIds()).toEqual(['doc:sign'])
    expect(getCommandsSnapshot()[0]).toBe(second[0])
  })

  it('picks up the new actions when what the screen can do changes', () => {
    const { rerender } = render(
      <Screen owner="document-detail" commands={[]} deps={['cannot-act']} />,
    )
    expect(registeredIds()).toEqual([])

    rerender(
      <Screen
        owner="document-detail"
        commands={[makeCommand()]}
        deps={['can-act']}
      />,
    )

    // The signing action appears only once the API has said this person is
    // the current approver. Until then the palette must not offer it.
    expect(registeredIds()).toEqual(['doc:sign'])
  })

  it('does not re-publish when a screen simply re-renders', async () => {
    const listener = vi.fn()
    const commands = [makeCommand()]

    function Host() {
      const [, bump] = useState(0)
      useRegisterCommands('document-detail', commands, [])
      return (
        <button type="button" onClick={() => bump(count => count + 1)}>
          Re-render
        </button>
      )
    }

    const { unmount } = render(<Host />)
    const stop = subscribeToCommands(listener)

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Re-render' }))

    // Every publish wakes the palette through `useSyncExternalStore`. If a
    // plain re-render republished, opening a document would re-render the
    // shell on every keystroke in its comment box.
    expect(listener).not.toHaveBeenCalled()

    // The listener was genuinely attached, though: a `subscribeToCommands`
    // that dropped it on the floor would satisfy the line above too, and
    // would go on satisfying it for every other silence this file asserts.
    unmount()
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  it('tells the palette when actions arrive and when they leave', () => {
    const listener = vi.fn()
    const stop = subscribeToCommands(listener)

    const { unmount } = render(<Screen owner="document-detail" commands={[makeCommand()]} />)
    expect(listener).toHaveBeenCalledTimes(1)

    unmount()

    // Without the second call the palette would keep showing an action that
    // the store has already dropped.
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })

  it('stops telling a listener that has unsubscribed, and only that one', () => {
    const unsubscribed = vi.fn()
    const stillWatching = vi.fn()
    const stop = subscribeToCommands(unsubscribed)
    const keepWatching = subscribeToCommands(stillWatching)
    stop()

    render(<Screen owner="document-detail" commands={[makeCommand()]} />)

    // The palette unmounts every time it closes. A subscription that outlived
    // it would keep calling into a dead component for the whole session.
    expect(unsubscribed).not.toHaveBeenCalled()

    // ...but unsubscribing one listener must not empty the set. Without this
    // control the assertion above is also satisfied by a publish that never
    // happened, and by a `stop()` that clears every subscriber in the app.
    expect(stillWatching).toHaveBeenCalledTimes(1)
    keepWatching()
  })

  it('hands back the same snapshot until something actually changes', () => {
    render(<Screen owner="document-detail" commands={[makeCommand()]} />)

    const first = getCommandsSnapshot()

    // `useSyncExternalStore` compares snapshots by identity. A fresh array on
    // every read makes React re-render for ever and throws "the result of
    // getSnapshot should be cached" - the palette would not render at all.
    expect(getCommandsSnapshot()).toBe(first)
  })

  it('gives a new snapshot once the registry has changed', () => {
    const { unmount } = render(<Screen owner="document-detail" commands={[makeCommand()]} />)
    const first = getCommandsSnapshot()

    unmount()

    expect(getCommandsSnapshot()).not.toBe(first)
    // A new reference is only half of it: it has to be a new reference around
    // the new contents. The old array staying valid beside it is the same bug
    // in a different shape.
    expect(getCommandsSnapshot()).toEqual([])
    expect(first).toHaveLength(1)
  })

  it('keeps the palette usable when a screen registers nothing at all', () => {
    const listener = vi.fn()
    const stop = subscribeToCommands(listener)

    render(<Screen owner="document-detail" commands={[makeCommand()]} />)
    render(<Screen owner="dashboard" commands={[]} />)

    // Most screens have no contextual actions. Registering an empty list is
    // the normal case, not an edge one - and it must not blank out the screen
    // that does have actions, which asserting an empty registry on its own
    // could never tell apart from the hook doing nothing whatsoever.
    expect(registeredIds()).toEqual(['doc:sign'])
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })
})
