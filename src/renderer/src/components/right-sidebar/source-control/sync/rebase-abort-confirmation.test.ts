import { describe, expect, it, vi } from 'vitest'
import type {
  ContinueRebaseResult,
  RebaseAbortSafety,
  RebaseStopToken
} from '../../../../../../shared/git/status/git-status-types'
import { confirmAndAbortRebase, type AbortConfirmRequest } from './rebase-abort-confirmation'

const STOP: RebaseStopToken = { head: 'h1', step: '1', incarnation: 'run-1' }
const PRISTINE: RebaseAbortSafety = { kind: 'pristine' }

function harness(answers: boolean[]) {
  const queue = [...answers]
  return {
    confirm: vi.fn(async (_request: AbortConfirmRequest) => queue.shift() ?? false),
    refuse: vi.fn((_safety: RebaseAbortSafety | null) => {}),
    beginAbort: vi.fn(),
    abort: vi.fn(async (_stop: RebaseStopToken): Promise<ContinueRebaseResult> => ({
      outcome: 'aborted'
    }))
  }
}

describe('confirmAndAbortRebase', () => {
  it("refuses, without asking, when Abort would discard the user's edits", async () => {
    const h = harness([true])
    const edits: RebaseAbortSafety = { kind: 'edits', files: ['a.txt'] }
    await expect(
      confirmAndAbortRebase({ ...h, inspect: async () => ({ stop: STOP, safety: edits }) })
    ).resolves.toBe('refused')
    expect(h.refuse).toHaveBeenCalledWith(edits)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('refuses when the host cannot verify, or cannot be asked', async () => {
    const h = harness([true])
    await confirmAndAbortRebase({
      ...h,
      inspect: async () => ({ stop: STOP, safety: { kind: 'unverifiable' } })
    })
    await confirmAndAbortRebase({ ...h, inspect: async () => null })
    expect(h.refuse.mock.calls).toEqual([[{ kind: 'unverifiable' }], [null]])
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('confirms a pristine stop, and Cancel aborts nothing', async () => {
    const h = harness([false])
    await expect(
      confirmAndAbortRebase({ ...h, inspect: async () => ({ stop: STOP, safety: PRISTINE }) })
    ).resolves.toBe('cancelled')
    expect(h.confirm.mock.calls[0][0]).toMatchObject({
      title: 'Abort rebase?',
      confirmLabel: 'Abort rebase'
    })
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('aborts the confirmed stop, re-asks when it moved, and refuses when the recheck found edits', async () => {
    const h = harness([true, true])
    h.abort
      .mockResolvedValueOnce({ outcome: 'abort_changed', stop: STOP, abortSafety: PRISTINE })
      .mockResolvedValueOnce({
        outcome: 'abort_blocked',
        stop: STOP,
        abortSafety: { kind: 'edits', files: ['late.txt'] }
      })
    await expect(
      confirmAndAbortRebase({ ...h, inspect: async () => ({ stop: STOP, safety: PRISTINE }) })
    ).resolves.toBe('refused')
    expect(h.abort).toHaveBeenCalledWith(STOP)
    expect(h.confirm).toHaveBeenCalledTimes(2)
    expect(h.refuse).toHaveBeenCalledWith({ kind: 'edits', files: ['late.txt'] })
  })
})
