import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { detectConflictOperation } from './git-conflict-operation'
import { continueRebase } from './rebase-continue'
import { createConflictingRebaseRepo } from './rebase-real-git.test-fixture'

describe('rebase Abort against real git', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function pausedRebase() {
    const repo = createConflictingRebaseRepo(tempPaths)
    expect(() => repo.git('rebase', 'main')).toThrow()
    return repo
  }

  it('names staged edits an unstaged edit cancels out, with exact file names', async () => {
    const { repoPath, git, write } = pausedRebase()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    write('c.txt', 'staged c\n')
    git('add', 'c.txt')
    write('c.txt', 'main c\n')
    write(' lead.txt', 'new\n')
    git('add', ' lead.txt')

    await expect(continueRebase(repoPath, 'inspect')).resolves.toMatchObject({
      abortWouldDiscard: [' lead.txt', 'a.txt', 'c.txt']
    })
  })

  it('aborts only the confirmed set, re-asking when it changed', async () => {
    const { repoPath, git, write } = pausedRebase()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    write('c.txt', 'edited during the pause\n')
    const inspected = await continueRebase(repoPath, 'inspect')
    expect(inspected.abortWouldDiscard).toEqual(['a.txt', 'c.txt'])

    write('b.txt', 'another edit\n')
    await expect(
      continueRebase(repoPath, 'abort', {
        expected: inspected.stop,
        expectedDiscards: inspected.abortWouldDiscard
      })
    ).resolves.toMatchObject({
      outcome: 'abort_changed',
      abortWouldDiscard: ['a.txt', 'b.txt', 'c.txt']
    })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
    expect(git('diff', '--name-only')).toContain('c.txt')

    await expect(
      continueRebase(repoPath, 'abort', {
        expected: inspected.stop,
        expectedDiscards: ['a.txt', 'b.txt', 'c.txt']
      })
    ).resolves.toEqual({ outcome: 'aborted' })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
  })
})
