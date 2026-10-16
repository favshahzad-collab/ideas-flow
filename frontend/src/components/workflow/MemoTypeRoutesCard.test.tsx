import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMemoTypeRoutes, saveMemoTypeRoute } from '../../services/memoTypeRoutesApi'
import MemoTypeRoutesCard from './MemoTypeRoutesCard'

/** The route each kind of memo starts from, set by an administrator. */

vi.mock('../../services/memoTypeRoutesApi', () => ({
  fetchMemoTypeRoutes: vi.fn(),
  saveMemoTypeRoute: vi.fn(),
}))

vi.mock('../../services/workflowTemplateApi', () => ({
  fetchActiveTemplates: () =>
    Promise.resolve([{ id: 't1', name: 'Finance route', isActive: true }]),
}))

const read = vi.mocked(fetchMemoTypeRoutes)
const save = vi.mocked(saveMemoTypeRoute)

const uploaded = (templateId: string | null, templateName: string | null = null) => ({
  key: 'UPLOADED',
  label: 'Uploaded PDF',
  templateId,
  templateName,
  templateActive: templateId !== null,
})

beforeEach(() => {
  read.mockReset().mockResolvedValue([uploaded(null)])
  save.mockReset()
})

describe('the route per kind of memo', () => {
  it('lists each kind with no route chosen', async () => {
    render(<MemoTypeRoutesCard />)

    expect(await screen.findByLabelText('Uploaded PDF')).toHaveValue('')
  })

  it('saves the workflow chosen for a kind', async () => {
    const user = userEvent.setup({ delay: null })
    save.mockResolvedValue([uploaded('t1', 'Finance route')])
    render(<MemoTypeRoutesCard />)

    await user.selectOptions(await screen.findByLabelText('Uploaded PDF'), 't1')
    await user.click(screen.getByRole('button', { name: 'Save the route for Uploaded PDF' }))

    expect(save).toHaveBeenCalledWith('UPLOADED', 't1')
    expect(await screen.findByRole('status')).toHaveTextContent('Finance route')
  })

  it('says when a route points at an archived workflow', async () => {
    read.mockResolvedValue([
      { key: 'UPLOADED', label: 'Uploaded PDF', templateId: 'old', templateName: 'Old route', templateActive: false },
    ])
    render(<MemoTypeRoutesCard />)

    expect(await screen.findByText(/was archived/)).toBeInTheDocument()
  })
})
