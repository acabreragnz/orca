import { describe, expect, it, vi } from 'vitest'
import type {
  ContinueRebaseResult,
  RebaseStopToken
} from '../../../../../../shared/git/status/git-status-types'
import { confirmAndAbortRebase, type AbortConfirmRequest } from './rebase-abort-confirmation'

const STOP: RebaseStopToken = { head: 'h1', step: '1', incarnation: 'run-1' }

function harness(answers: boolean[]) {
  const queue = [...answers]
  return {
    confirm: vi.fn(async (_request: AbortConfirmRequest) => queue.shift() ?? false),
    refuse: vi.fn((_blockedBy: string[] | null) => {}),
    beginAbort: vi.fn(),
    abort: vi.fn(
      async (_stop: RebaseStopToken, _discards: string[]): Promise<ContinueRebaseResult> => ({
        outcome: 'aborted'
      })
    )
  }
}

describe('confirmAndAbortRebase', () => {
  it('refuses, without asking, when other tracked edits would be discarded', async () => {
    const h = harness([true])
    await expect(
      confirmAndAbortRebase({
        ...h,
        inspect: async () => ({ stop: STOP, discards: ['a.txt'], blockedBy: ['notes.txt'] })
      })
    ).resolves.toBe('refused')
    expect(h.refuse).toHaveBeenCalledWith(['notes.txt'])
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('refuses when the host cannot tell what Abort would discard', async () => {
    const h = harness([true])
    await expect(confirmAndAbortRebase({ ...h, inspect: async () => null })).resolves.toBe(
      'refused'
    )
    expect(h.refuse).toHaveBeenCalledWith(null)
    expect(h.abort).not.toHaveBeenCalled()
  })

  it("names the pick's own edits, and Cancel aborts nothing", async () => {
    const h = harness([false])
    await expect(
      confirmAndAbortRebase({
        ...h,
        inspect: async () => ({ stop: STOP, discards: ['a.txt', 'b.txt'], blockedBy: [] })
      })
    ).resolves.toBe('cancelled')
    expect(h.confirm.mock.calls[0][0]).toMatchObject({
      title: 'Abort rebase and discard edits to 2 files?',
      description: 'a.txt, b.txt',
      confirmLabel: 'Discard and abort'
    })
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('aborts only the confirmed stop and set', async () => {
    const h = harness([true])
    await confirmAndAbortRebase({
      ...h,
      inspect: async () => ({ stop: STOP, discards: ['a.txt'], blockedBy: [] })
    })
    expect(h.abort).toHaveBeenCalledWith(STOP, ['a.txt'])
  })

  it('asks again when the set changed, and refuses when the recheck found other edits', async () => {
    const h = harness([true, true])
    h.abort
      .mockResolvedValueOnce({
        outcome: 'abort_changed',
        stop: STOP,
        abortWouldDiscard: ['a.txt', 'b.txt'],
        abortBlockedBy: []
      })
      .mockResolvedValueOnce({
        outcome: 'abort_blocked',
        stop: STOP,
        abortWouldDiscard: ['a.txt'],
        abortBlockedBy: ['late.txt']
      })
    await expect(
      confirmAndAbortRebase({
        ...h,
        inspect: async () => ({ stop: STOP, discards: ['a.txt'], blockedBy: [] })
      })
    ).resolves.toBe('refused')
    expect(h.confirm.mock.calls[1][0]).toMatchObject({ description: 'a.txt, b.txt' })
    expect(h.refuse).toHaveBeenCalledWith(['late.txt'])
  })

  it('keeps the plain confirm only when the tree is proven clean', async () => {
    const h = harness([false])
    await confirmAndAbortRebase({
      ...h,
      inspect: async () => ({ stop: STOP, discards: [], blockedBy: [] })
    })
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ confirmLabel: 'Abort rebase' })
  })
})
