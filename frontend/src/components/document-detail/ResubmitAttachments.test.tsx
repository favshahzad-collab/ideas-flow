import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { attachmentVersionsLabel } from '../../utils/documentDetailMapper'
import ResubmitAttachments from './ResubmitAttachments'

/**
 * The supporting files a revision carries: kept unless unticked, with new
 * ones added beside them (fit-gap decision 8).
 */

const scale = {
  id: 'a1',
  fileName: 'salary-scale.pdf',
  contentType: 'application/pdf',
  sizeLabel: '12 KB',
  uploadedAt: '1 Oct 2026',
}

describe('the supporting files for a revision', () => {
  it('keeps every current file by default', () => {
    render(
      <ResubmitAttachments
        current={[scale]}
        removeIds={[]}
        onToggleKeep={vi.fn()}
        added={[]}
        onAdd={vi.fn()}
        onRemoveAdded={vi.fn()}
      />,
    )

    expect(screen.getByLabelText(/Keep salary-scale.pdf/)).toBeChecked()
  })

  it('takes one off when it is unticked', async () => {
    const user = userEvent.setup({ delay: null })
    const onToggleKeep = vi.fn()
    render(
      <ResubmitAttachments
        current={[scale]}
        removeIds={[]}
        onToggleKeep={onToggleKeep}
        added={[]}
        onAdd={vi.fn()}
        onRemoveAdded={vi.fn()}
      />,
    )

    await user.click(screen.getByLabelText(/Keep salary-scale.pdf/))

    expect(onToggleKeep).toHaveBeenCalledWith('a1', false)
  })

  it('lists the files being added, each removable', async () => {
    const user = userEvent.setup({ delay: null })
    const onRemoveAdded = vi.fn()
    render(
      <ResubmitAttachments
        current={[]}
        removeIds={[]}
        onToggleKeep={vi.fn()}
        added={[new File(['x'], 'scale-2027.pdf')]}
        onAdd={vi.fn()}
        onRemoveAdded={onRemoveAdded}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Do not add scale-2027.pdf' }))

    expect(onRemoveAdded).toHaveBeenCalledWith(0)
  })
})

describe('which versions carried a file', () => {
  it.each([
    [1, null, 'Since version 1'],
    [1, 2, 'Version 1 only'],
    [1, 3, 'Versions 1–2'],
    [undefined, null, undefined],
  ] as const)('added %s, removed %s reads "%s"', (added, removed, label) => {
    expect(attachmentVersionsLabel(added, removed)).toBe(label)
  })
})
