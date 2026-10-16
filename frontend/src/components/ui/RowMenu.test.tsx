import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import RowMenu, { MenuItem } from './RowMenu'

/**
 * The overflow menu at the end of a 34px table row. Everything secondary lives
 * behind it - including "Delete", and including, on the people table, actions
 * that apply to one named person out of forty identical-looking rows.
 *
 * Two things could hurt somebody here. One is the menu acting on the wrong row,
 * which is what the trigger's stopPropagation is for: a row is itself
 * clickable, and a press that both opened the menu and navigated away would
 * leave the menu hanging over a different document. The other is a menu that
 * cannot be closed or escaped from by keyboard, stranding a person on top of
 * the row they were trying to read.
 */

function renderMenu(
  items: (close: () => void) => ReactNode = close => (
    <>
      <MenuItem onSelect={close}>Open</MenuItem>
      <MenuItem onSelect={close}>Duplicate</MenuItem>
      <MenuItem tone="danger" onSelect={close}>
        Delete
      </MenuItem>
    </>
  ),
  label = 'Actions for Priya Nair',
) {
  return render(<RowMenu label={label}>{items}</RowMenu>)
}

const trigger = (name = 'Actions for Priya Nair') =>
  screen.getByRole('button', { name })

describe('the trigger', () => {
  it('names the row it belongs to, since the icon says nothing', () => {
    // Forty rows, forty identical three-dot buttons. Without the name in the
    // label, a screen reader offers a list of forty "button"s.
    renderMenu()

    expect(trigger()).toBeInTheDocument()
  })

  it('advertises that it opens a menu, and whether it is open', async () => {
    renderMenu()

    // aria-expanded is the only cue a screen reader has that the press did
    // anything; the menu itself is drawn somewhere it will not be read next.
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(trigger())
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
  })

  it('points at the open menu by id, and at nothing while closed', async () => {
    renderMenu()

    expect(trigger()).not.toHaveAttribute('aria-controls')

    await userEvent.click(trigger())
    const menu = screen.getByRole('menu', { name: 'Actions for Priya Nair' })
    // A dangling aria-controls pointing at an element that is not in the
    // document is worse than none: it tells assistive tech to go nowhere.
    expect(trigger()).toHaveAttribute('aria-controls', menu.id)
  })

  it('opens and closes on repeated presses', async () => {
    renderMenu()

    await userEvent.click(trigger())
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await userEvent.click(trigger())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not also fire the row it sits in', async () => {
    // The row opens the document. If opening the menu bubbled, one press would
    // navigate away and the menu would reappear over a different document.
    const onRowClick = vi.fn()
    render(
      <div onClick={onRowClick}>
        <RowMenu label="Actions for Priya Nair">
          {close => <MenuItem onSelect={close}>Open</MenuItem>}
        </RowMenu>
      </div>,
    )

    await userEvent.click(trigger())

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('does not fire the row when something inside the menu is pressed either', async () => {
    const onRowClick = vi.fn()
    const onSelect = vi.fn()
    render(
      <div onClick={onRowClick}>
        <RowMenu label="Actions for Priya Nair">
          {() => <MenuItem onSelect={onSelect}>Delete</MenuItem>}
        </RowMenu>
      </div>,
    )

    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe('while it is shut', () => {
  it('has not rendered the menu at all, rather than hidden it', async () => {
    // Absent, not merely invisible. A menu that is rendered up front and styled
    // out of sight still puts its items into the tab order of every one of
    // forty rows, and a screen reader still reads all hundred and twenty of
    // them - the exact failure the aria-expanded test cannot see, because a
    // hidden-but-present menu reports "false" just as happily.
    const items = vi.fn((close: () => void) => <MenuItem onSelect={close}>Open</MenuItem>)
    render(<RowMenu label="Actions for Priya Nair">{items}</RowMenu>)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    expect(screen.queryByText('Open')).not.toBeInTheDocument()
    // And the row's actions are not even built while it is shut. The render
    // prop is where a caller works out what this row may do - permissions,
    // "is this mine to delete" - and running that forty times on first paint is
    // what the render prop was chosen to avoid.
    expect(items).not.toHaveBeenCalled()

    await userEvent.click(trigger())

    expect(items).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
  })

  it('keeps two rows of these apart, and opens only the one that was pressed', async () => {
    // Forty of these on a table. The menu id comes from useId; a constant would
    // point both triggers' aria-controls at the same node, so assistive tech
    // following the second one lands on the first row's actions and a person
    // deletes a document belonging to somebody else.
    render(
      <>
        <RowMenu label="Actions for Priya Nair">
          {close => <MenuItem onSelect={close}>Open Priya</MenuItem>}
        </RowMenu>
        <RowMenu label="Actions for Bilal Ahmed">
          {close => <MenuItem onSelect={close}>Open Bilal</MenuItem>}
        </RowMenu>
      </>,
    )

    await userEvent.click(trigger('Actions for Bilal Ahmed'))

    expect(screen.getByRole('menuitem', { name: 'Open Bilal' })).toBeInTheDocument()
    expect(screen.queryByText('Open Priya')).not.toBeInTheDocument()
    expect(trigger('Actions for Priya Nair')).toHaveAttribute('aria-expanded', 'false')

    const bilal = screen.getByRole('menu', { name: 'Actions for Bilal Ahmed' })
    expect(bilal.id).not.toBe('')
    expect(trigger('Actions for Bilal Ahmed')).toHaveAttribute('aria-controls', bilal.id)

    // And opening the next row shuts the one before it, or the table ends up
    // wearing two menus at once.
    await userEvent.click(trigger('Actions for Priya Nair'))

    expect(screen.getByRole('menuitem', { name: 'Open Priya' })).toBeInTheDocument()
    expect(screen.queryByText('Open Bilal')).not.toBeInTheDocument()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
  })
})

describe('the open menu', () => {
  it('is a menu of menu items, named the same as its trigger', async () => {
    renderMenu()
    await userEvent.click(trigger())

    expect(screen.getByRole('menu', { name: 'Actions for Priya Nair' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Open',
      'Duplicate',
      'Delete',
    ])
  })

  it('runs the item that was chosen and closes behind it', async () => {
    // A menu that stays open covers the row it just changed, so the person
    // cannot see whether the thing they pressed actually happened.
    const onSelect = vi.fn()
    renderMenu(close => (
      <MenuItem
        onSelect={() => {
          onSelect()
          close()
        }}
      >
        Duplicate
      </MenuItem>
    ))

    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('leaves the menu open when the item chooses not to close it', async () => {
    // Some items open a confirm dialog and want the menu to stay put behind it.
    renderMenu(() => <MenuItem onSelect={() => {}}>Delete</MenuItem>)

    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('honours a disabled item instead of only greying it', async () => {
    const onSelect = vi.fn()
    renderMenu(() => (
      <MenuItem onSelect={onSelect} disabled title="You did not prepare this document.">
        Delete
      </MenuItem>
    ))

    await userEvent.click(trigger())
    const item = screen.getByRole('menuitem', { name: 'Delete' })

    expect(item).toBeDisabled()
    await userEvent.click(item)
    // Destructive and unavailable: a grey-but-live Delete is the worst of the
    // failure modes this component can have.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('says why an item is unavailable rather than leaving it a mystery', async () => {
    renderMenu(() => (
      <MenuItem onSelect={() => {}} disabled title="You did not prepare this document.">
        Delete
      </MenuItem>
    ))

    await userEvent.click(trigger())

    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'title',
      'You did not prepare this document.',
    )
  })

  it('renders whatever a row needs, including a menu with a single item', async () => {
    renderMenu(close => <MenuItem onSelect={close}>Open</MenuItem>)

    await userEvent.click(trigger())

    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  })
})

describe('getting out of it', () => {
  it('closes on Escape and puts focus back on the trigger', async () => {
    // Without the focus restore, Escape drops a keyboard user at the top of the
    // document and they have to Tab back through the whole table to their row.
    renderMenu()

    await userEvent.click(trigger())
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('closes when the person presses somewhere else on the page', async () => {
    // Otherwise the menu follows them around the screen, floating over rows it
    // has nothing to do with.
    render(
      <>
        <button type="button">Somewhere else</button>
        <RowMenu label="Actions for Priya Nair">
          {close => <MenuItem onSelect={close}>Open</MenuItem>}
        </RowMenu>
      </>,
    )

    await userEvent.click(trigger())
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Somewhere else' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('ignores Escape while it is closed, and does not steal focus', async () => {
    // The keydown listener is only attached while the menu is open. If it were
    // permanent, every one of forty closed row menus would grab Escape from
    // whatever dialog or search box the person actually meant it for.
    render(
      <>
        <button type="button">Search</button>
        <RowMenu label="Actions for Priya Nair">
          {close => <MenuItem onSelect={close}>Open</MenuItem>}
        </RowMenu>
      </>,
    )

    const other = screen.getByRole('button', { name: 'Search' })
    other.focus()
    await userEvent.keyboard('{Escape}')

    expect(other).toHaveFocus()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
  })

  it('leaves Tab moving on through the menu, having started inside it', async () => {
    // Focus lands on the first item when the menu opens, so Tab from there
    // reaches the second rather than the first. This used to document the
    // opposite - that the trigger kept focus - back when it did.
    renderMenu()

    trigger().focus()
    await userEvent.click(trigger())
    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toHaveFocus()
  })

  it('moves focus into the menu when it opens', async () => {
    // Reported defect. The menu-button pattern puts focus on the first item, so
    // a screen reader announces the menu and its length instead of leaving the
    // person on a trigger that now says "expanded" with nothing read out.
    renderMenu()

    await userEvent.click(trigger())

    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus()
  })

  it('moves between items with the arrow keys', async () => {
    // Reported defect. role="menu" switches a screen reader into application
    // mode, where Up and Down are handed to the widget rather than used to read
    // the page - so with no arrow handling the person has no way through.
    renderMenu()

    await userEvent.click(trigger())
    screen.getByRole('menuitem', { name: 'Open' }).focus()
    await userEvent.keyboard('{ArrowDown}')

    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toHaveFocus()
  })

  it('returns focus to the trigger after an item closes the menu', async () => {
    // Reported defect. The chosen item unmounts under the caret, so focus falls
    // to <body> and the next Tab restarts from the top of the page - the same
    // loss Escape is careful to avoid.
    renderMenu()

    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))

    expect(trigger()).toHaveFocus()
  })
})
