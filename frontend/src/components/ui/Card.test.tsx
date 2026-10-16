import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Avatar, Badge, Card, CardHeader, Chip, type Tone } from './Card'

/**
 * The read-only furniture of every screen: the panel, its header, the count
 * pills, the filter chips and the initials circle.
 *
 * Almost everything these five decide is decoration, and decoration that is
 * announced is worse than decoration that is silent - an avatar read aloud
 * turns "Ayesha Khan" into "A K, Ayesha Khan", and a coloured dot read as
 * "image" beside a badge tells a person nothing. So what is asserted here is
 * mostly the opposite of what is asserted elsewhere: that these things stay
 * OUT of the accessibility tree, and that the parts a person acts on - the
 * chip and its dismiss X - are real, separately named buttons.
 */

const Tag = () => <span>ICON</span>

/**
 * Every tone the accent map defines. Listed here rather than imported,
 * because `TONES` is deliberately private to the component — a test that
 * read the map would only prove the map agrees with itself.
 */
const TONES: Tone[] = ['accent', 'info', 'warning', 'danger', 'revision', 'neutral']

describe('Card', () => {
  it('wraps what it was given in exactly one sectioning element', () => {
    const { container } = render(
      <Card>
        <p>Four documents are waiting on you.</p>
      </Card>,
    )

    const body = screen.getByText('Four documents are waiting on you.')
    // A <section>, not a div: the panels are what somebody skims a screen by,
    // and one section per Card is what makes that skim possible. One container,
    // too - a Card that rendered a wrapper round a wrapper would nest every
    // panel on the page one level deeper than the layout expects.
    expect(container.children).toHaveLength(1)
    expect(body.closest('section')).toBe(container.firstElementChild)
  })

  it.each(TONES)('draws the %s accent without adding anything to read', tone => {
    // The accent is a 2px coloured rule and nothing else. If it ever became the
    // only carrier of "this tile is the overdue one", a person who cannot see
    // the colour would lose the distinction entirely - so the text beside it is
    // what has to say which tile this is.
    const { container } = render(<Card accent={tone}>Overdue: 3</Card>)

    const section = container.firstElementChild as HTMLElement
    // Nothing announced and nothing extra in the tree: the accented Card says
    // exactly what the plain one says, and the rule carries no label of its own.
    expect(section.textContent).toBe('Overdue: 3')
    expect(section.children).toHaveLength(0)
    expect(section).not.toHaveAttribute('aria-label')
    // Not which class - a restyle renames them all - but that the tone resolved
    // to something. A tone missing from the map puts the literal "undefined"
    // into the class attribute and draws no rule at all, which is the one way
    // an accent can be silently wrong rather than merely a different colour.
    expect(section.getAttribute('class')).not.toMatch(/undefined/)
  })

  it('renders the same content when no accent is asked for', () => {
    const { container } = render(<Card>Overdue: 3</Card>)

    const section = container.firstElementChild as HTMLElement
    expect(section.textContent).toBe('Overdue: 3')
    expect(section.getAttribute('class')).not.toMatch(/undefined/)
  })

  it('draws a different rule for each tone, and none at all when asked for none', () => {
    // Six tones that all resolved to the same rule pass every assertion above:
    // each tile renders, says its own words, adds nothing to the tree and
    // carries no "undefined". They would just all be one colour, and the KPI
    // row would lose the only thing separating the overdue tile from the
    // approved one. Which class is never asserted - only that the six differ.
    const classFor = (accent?: Tone) => {
      const { container, unmount } = render(<Card accent={accent}>Overdue: 3</Card>)
      const value = (container.firstElementChild as HTMLElement).className
      unmount()
      return value
    }

    const toned = TONES.map(classFor)
    expect(new Set(toned).size).toBe(TONES.length)

    // And the negative the loop cannot state on its own: a Card asked for no
    // accent must not quietly draw one anyway. Without this, a component that
    // hard-coded one rule onto every Card would satisfy the whole file.
    expect(toned).not.toContain(classFor(undefined))
  })

  it('keeps the caller className, which is how a Card is sized on a grid', () => {
    // The class asserted is one this test invented, so a restyle cannot move it.
    render(<Card className="daws-test-hook">Overdue: 3</Card>)

    expect(screen.getByText('Overdue: 3')).toHaveClass('daws-test-hook')
  })
})

describe('CardHeader', () => {
  it('gives the panel a real heading a screen reader can jump to', () => {
    // Panel titles are how somebody skims a screen by headings. Styled bold
    // text would look identical and be invisible to that.
    render(<CardHeader title="Approval chain" />)

    expect(
      screen.getByRole('heading', { level: 2, name: 'Approval chain' }),
    ).toBeInTheDocument()
  })

  it('hides the decorative icon tile so the title is not read twice', () => {
    render(<CardHeader icon={Tag} title="Approval chain" />)

    // The icon repeats the title in picture form; announced, it becomes noise
    // in front of every panel name on the page.
    expect(screen.getByText('ICON').parentElement).toHaveAttribute('aria-hidden', 'true')
  })

  it('tints the icon tile by tone, and hides it whichever tone it is', () => {
    // The tone map is read here as well as in Badge, and nothing else in this
    // file exercises it past its default. A tone missing from the map puts the
    // literal "undefined" in the class attribute: the tile loses its background
    // and the icon floats on the header with no shape behind it.
    const seen = TONES.map(tone => {
      const { unmount } = render(
        <CardHeader icon={Tag} tone={tone} title="Approval chain" />,
      )
      const tile = screen.getByText('ICON').parentElement as HTMLElement
      expect(tile).toHaveAttribute('aria-hidden', 'true')
      expect(tile.getAttribute('class')).not.toMatch(/undefined/)
      const value = tile.className
      unmount()
      return value
    })

    expect(new Set(seen).size).toBe(TONES.length)
  })

  it('renders the hint under the title rather than folding it into the heading', () => {
    render(
      <CardHeader
        title="Approval chain"
        hint="Everyone who has to sign, in order."
      />,
    )

    // The heading must stay the short thing that appears in a heading list.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^Approval chain$/,
    )
    expect(screen.getByText('Everyone who has to sign, in order.')).toBeInTheDocument()
  })

  it('shows the meta value as text, not as an unreadable badge', () => {
    render(<CardHeader title="Approval chain" meta="3 steps" />)

    expect(screen.getByText('3 steps')).toBeInTheDocument()
  })

  it('keeps header actions operable', async () => {
    const onClick = vi.fn()
    render(
      <CardHeader
        title="Approval chain"
        actions={
          <button type="button" onClick={onClick}>
            Edit
          </button>
        }
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders with nothing but a title', () => {
    // The commonest call in the app passes only `title`; an optional-prop
    // regression here would break most panels at once.
    render(<CardHeader title="Approval chain" />)

    expect(screen.getByRole('heading', { name: 'Approval chain' })).toBeInTheDocument()
    expect(screen.queryByText('ICON')).not.toBeInTheDocument()
  })
})

describe('Badge', () => {
  it('says its count in words, whatever the tone', () => {
    render(<Badge tone="danger">3 overdue</Badge>)

    // A count that exists only as a red pill is a count nobody can read out.
    expect(screen.getByText('3 overdue')).toBeInTheDocument()
  })

  it('hides the leading dot from assistive tech', () => {
    render(
      <Badge tone="warning" dot>
        Awaiting review
      </Badge>,
    )

    const badge = screen.getByText(/Awaiting review/)
    // The dot repeats the tone the words already carry; announced, every badge
    // on the row gains a stray "image" in front of it.
    expect(badge.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(badge).toHaveTextContent(/^Awaiting review$/)
  })

  it('renders no dot element at all when dot is off', () => {
    render(<Badge>Draft</Badge>)

    expect(screen.getByText('Draft').firstElementChild).toBeNull()
  })

  it('gives each tone its own pill and its own dot, with neither left unstyled', () => {
    // Two maps are keyed by tone here - the pill and the dot - and until now
    // only two of the six tones were ever rendered. A tone missing from either
    // map interpolates "undefined" into the class attribute: the pill loses its
    // border and background and reads as bare text in a row of pills, or the
    // dot becomes an invisible gap that still takes up its 5px.
    const seen = TONES.map(tone => {
      const { unmount } = render(
        <Badge tone={tone} dot>
          3 overdue
        </Badge>,
      )
      const badge = screen.getByText(/3 overdue/)
      const dot = badge.firstElementChild as HTMLElement

      expect(badge.getAttribute('class')).not.toMatch(/undefined/)
      expect(dot.getAttribute('class')).not.toMatch(/undefined/)
      // The dot stays silent in every tone, not only in the two spelled out
      // above - six tones is six chances to leave one announced.
      expect(dot).toHaveAttribute('aria-hidden', 'true')

      const pair = [badge.className, dot.className].join('|')
      unmount()
      return pair
    })

    expect(new Set(seen).size).toBe(TONES.length)
  })

  it('survives a zero count and a very long label', () => {
    const { unmount } = render(<Badge>0</Badge>)
    expect(screen.getByText('0')).toBeInTheDocument()
    unmount()

    const long = 'Awaiting final approval from the finance director'
    render(<Badge>{long}</Badge>)
    expect(screen.getByText(long)).toBeInTheDocument()
  })
})

describe('Chip', () => {
  it('is a button a keyboard can reach, not a decorated span', async () => {
    const onClick = vi.fn()
    render(<Chip onClick={onClick}>Pending review</Chip>)

    await userEvent.tab()
    const chip = screen.getByRole('button', { name: 'Pending review' })
    expect(chip).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('announces whether the filter is currently on', () => {
    // Active is otherwise a tint. Without aria-pressed, a person who cannot see
    // the tint has no way to know which filters are narrowing their list - so
    // they cannot tell why a document they expect is missing.
    const { unmount } = render(<Chip active>Pending review</Chip>)
    expect(screen.getByRole('button', { name: 'Pending review' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    unmount()

    render(<Chip>Pending review</Chip>)
    expect(screen.getByRole('button', { name: 'Pending review' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('gives the dismiss X its own accessible name', () => {
    render(
      <Chip onDismiss={() => {}} dismissLabel="Remove the pending review filter">
        Pending review
      </Chip>,
    )

    // An unlabelled X is announced as "button" - one of several identical
    // "button"s in a row of chips, with no way to tell which filter it drops.
    expect(
      screen.getByRole('button', { name: 'Remove the pending review filter' }),
    ).toBeInTheDocument()
  })

  it('falls back to a generic dismiss name when the caller gives none', () => {
    render(<Chip onDismiss={() => {}}>Pending review</Chip>)

    expect(screen.getByRole('button', { name: 'Remove filter' })).toBeInTheDocument()
  })

  it('removes the filter without also toggling it', async () => {
    // The X sits inside the chip. If the press bubbled to the label button, one
    // click would both drop the filter and flip it - and the list would settle
    // on whichever won the race.
    const onClick = vi.fn()
    const onDismiss = vi.fn()
    render(
      <Chip onClick={onClick} onDismiss={onDismiss}>
        Pending review
      </Chip>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Remove filter' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps the dismiss X beside the label button rather than inside it', () => {
    // A button nested in a button is invalid HTML, and the browser recovers
    // from it by hoisting the inner one out of its parent - which moves the X
    // somewhere the layout never put it and hands the label's handler every
    // press of it. The stopPropagation test above only proves the two handlers
    // stay apart; this proves the markup they hang off is legal at all.
    render(
      <Chip onClick={() => {}} onDismiss={() => {}}>
        Pending review
      </Chip>,
    )

    const label = screen.getByRole('button', { name: 'Pending review' })
    const dismiss = screen.getByRole('button', { name: 'Remove filter' })

    expect(label.contains(dismiss)).toBe(false)
    expect(dismiss.closest('button')).toBe(dismiss)
  })

  it('offers no dismiss button when the chip cannot be dismissed', () => {
    render(<Chip>Pending review</Chip>)

    // A dead X is worse than no X: a person presses it and nothing happens.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('is really disabled when the caller disables it', async () => {
    const onClick = vi.fn()
    render(
      <Chip disabled onClick={onClick}>
        Pending review
      </Chip>,
    )

    const chip = screen.getByRole('button', { name: 'Pending review' })
    expect(chip).toBeDisabled()
    await userEvent.click(chip)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('Avatar', () => {
  it('stays out of the accessibility tree beside the name it abbreviates', () => {
    render(<Avatar firstName="Ayesha" lastName="Khan" />)

    // Announced, the row reads "A K Ayesha Khan". The initials are a picture of
    // the name that is already there.
    expect(screen.getByText('AK')).toHaveAttribute('aria-hidden', 'true')
  })

  it('derives initials from a first and last name, in capitals', () => {
    render(<Avatar firstName="ayesha" lastName="khan" />)

    expect(screen.getByText('AK')).toBeInTheDocument()
  })

  it('prefers initials the API already computed', () => {
    render(<Avatar initials="BA" firstName="Ayesha" lastName="Khan" />)

    expect(screen.getByText('BA')).toBeInTheDocument()
    expect(screen.queryByText('AK')).not.toBeInTheDocument()
  })

  it('falls back to a question mark rather than an empty circle', () => {
    // A blank disc reads as a broken image; "?" reads as "we do not know who".
    render(<Avatar />)

    expect(screen.getByText('?')).toBeInTheDocument()
  })

  it('treats a whitespace-only initials string as absent', () => {
    render(<Avatar initials="   " firstName="Ayesha" lastName="Khan" />)

    expect(screen.getByText('AK')).toBeInTheDocument()
  })

  it('copes with only one half of a name', () => {
    const { unmount } = render(<Avatar firstName="Ayesha" />)
    expect(screen.getByText('A')).toBeInTheDocument()
    unmount()

    render(<Avatar lastName="Khan" />)
    expect(screen.getByText('K')).toBeInTheDocument()
  })

  it('hides the presence dot too, so availability is never colour alone', () => {
    render(<Avatar firstName="Ayesha" lastName="Khan" presence="away" />)

    const disc = screen.getByText('AK')
    const dot = disc.nextElementSibling

    // Away, available and deactivated differ only in the dot's colour. It is
    // hidden on purpose: the row beside it has to spell the state out in words.
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot).toHaveTextContent('')
  })

  it('renders the same initials with and without a presence ring', () => {
    const { unmount } = render(<Avatar initials="AK" />)
    expect(screen.getByText('AK')).toBeInTheDocument()
    unmount()

    render(<Avatar initials="AK" presence="available" presenceRing="sunken" />)
    expect(screen.getByText('AK')).toBeInTheDocument()
  })

  it('resolves every size it offers, and keeps them apart', () => {
    // Four sizes, and until now every test above took the default. A key
    // missing from the map puts "undefined" where the height and width should
    // be and the disc collapses around its initials; two keys sharing a value
    // puts the 30px signed-in avatar into a 22px table row.
    const sizes = (['xs', 'sm', 'md', 'lg'] as const).map(size => {
      const { unmount } = render(<Avatar initials="AK" size={size} />)
      const disc = screen.getByText('AK')
      expect(disc.getAttribute('class')).not.toMatch(/undefined/)
      const value = disc.className
      unmount()
      return value
    })

    expect(new Set(sizes).size).toBe(4)
  })

  it('resolves every tone it offers, and keeps them apart', () => {
    // `accentSolid` is the signed-in user and is deliberately louder than the
    // tinted list avatars. Collapsed onto plain `accent`, every avatar in a
    // list would read as "you".
    const tones = (['neutral', 'accentSolid', 'accent', 'info', 'success'] as const).map(
      tone => {
        const { unmount } = render(<Avatar initials="AK" tone={tone} />)
        const disc = screen.getByText('AK')
        expect(disc.getAttribute('class')).not.toMatch(/undefined/)
        const value = disc.className
        unmount()
        return value
      },
    )

    expect(new Set(tones).size).toBe(5)
  })

  it('draws each presence state differently, and hides all three', () => {
    // Available, away and deactivated differ in nothing but this dot's colour.
    // Two of them rendering the same colour is the failure that matters: a
    // person who has left the company would look merely out of the office.
    const dots = (['available', 'away', 'deactivated'] as const).map(presence => {
      const { unmount } = render(<Avatar initials="AK" presence={presence} />)
      const dot = screen.getByText('AK').nextElementSibling as HTMLElement
      expect(dot).toHaveAttribute('aria-hidden', 'true')
      expect(dot.getAttribute('class')).not.toMatch(/undefined/)
      const value = dot.className
      unmount()
      return value
    })

    expect(new Set(dots).size).toBe(3)
  })

  it('cuts the presence ring out of whichever surface it sits on', () => {
    // The ring is a border in the colour of whatever is behind the avatar. One
    // missing key and it is drawn in no colour at all, which reads as a dot
    // with a bite taken out of it against every surface but one.
    const rings = (['surface', 'shell', 'sunken'] as const).map(presenceRing => {
      const { unmount } = render(
        <Avatar initials="AK" presence="available" presenceRing={presenceRing} />,
      )
      const dot = screen.getByText('AK').nextElementSibling as HTMLElement
      expect(dot.getAttribute('class')).not.toMatch(/undefined/)
      const value = dot.className
      unmount()
      return value
    })

    expect(new Set(rings).size).toBe(3)
  })
})
