import { rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
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

  /** Paused on the first pick, which only touches a.txt; c.txt is not the pick's. */
  function pausedRebase() {
    const repo = createConflictingRebaseRepo(tempPaths)
    expect(() => repo.git('rebase', 'main')).toThrow()
    return repo
  }

  async function expectRefusedKeeping(repoPath: string, git: (...args: string[]) => string) {
    const before = git('diff', 'HEAD', '--binary') + git('diff', '--cached', '--binary')
    const inspected = await continueRebase(repoPath, 'inspect')
    await expect(
      continueRebase(repoPath, 'abort', {
        expected: inspected.stop,
        expectedDiscards: inspected.abortWouldDiscard
      })
    ).resolves.toMatchObject({ outcome: 'abort_blocked' })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
    expect(git('diff', 'HEAD', '--binary') + git('diff', '--cached', '--binary')).toBe(before)
    return inspected
  }

  it('refuses for a staged-only edit outside the pick', async () => {
    const { repoPath, git, write } = pausedRebase()
    write('c.txt', 'staged c\n')
    git('add', 'c.txt')
    const inspected = await expectRefusedKeeping(repoPath, git)
    expect(inspected.abortBlockedBy).toEqual(['c.txt'])
  })

  it('refuses for an unstaged-only edit outside the pick', async () => {
    const { repoPath, git, write } = pausedRebase()
    write('c.txt', 'unstaged c\n')
    const inspected = await expectRefusedKeeping(repoPath, git)
    expect(inspected.abortBlockedBy).toEqual(['c.txt'])
  })

  it('refuses for a staged edit an unstaged edit cancels out', async () => {
    const { repoPath, git, write } = pausedRebase()
    write('c.txt', 'staged c\n')
    git('add', 'c.txt')
    write('c.txt', 'main c\n')
    const inspected = await expectRefusedKeeping(repoPath, git)
    expect(inspected.abortBlockedBy).toEqual(['c.txt'])
  })

  // Windows forbids these characters in file names.
  it.skipIf(process.platform === 'win32')(
    'refuses for pathspec-like file names, naming them exactly',
    async () => {
      const { repoPath, git, write } = pausedRebase()
      write(':(top)x', 'new\n')
      write('*', 'new\n')
      git('add', '--', ':(literal):(top)x', ':(literal)*')
      const inspected = await expectRefusedKeeping(repoPath, git)
      expect(inspected.abortBlockedBy).toEqual(['*', ':(top)x'])
    }
  )

  it('refuses when it cannot read the stopped pick', async () => {
    const { repoPath, git, write } = pausedRebase()
    write('a.txt', 'resolved a\n')
    unlinkSync(join(repoPath, '.git', 'REBASE_HEAD'))
    const inspected = await expectRefusedKeeping(repoPath, git)
    expect(inspected.abortWouldDiscard).toBeUndefined()
  })

  it("confirms the pick's own edits, re-asks when they changed, then aborts", async () => {
    const { repoPath, git, write } = pausedRebase()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    const inspected = await continueRebase(repoPath, 'inspect')
    expect(inspected).toMatchObject({ abortWouldDiscard: ['a.txt'], abortBlockedBy: [] })

    await expect(
      continueRebase(repoPath, 'abort', { expected: inspected.stop, expectedDiscards: [] })
    ).resolves.toMatchObject({ outcome: 'abort_changed', abortWouldDiscard: ['a.txt'] })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')

    await expect(
      continueRebase(repoPath, 'abort', { expected: inspected.stop, expectedDiscards: ['a.txt'] })
    ).resolves.toEqual({ outcome: 'aborted' })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
  })

  it('aborts a modify/delete conflict without touching anything outside the pick', async () => {
    const { repoPath, git, write } = createConflictingRebaseRepo(tempPaths)
    git('checkout', '--quiet', '-b', 'remove-a', 'main~1')
    git('rm', '--quiet', 'a.txt')
    git('commit', '--quiet', '-m', 'remove a')
    expect(() => git('rebase', 'main')).toThrow()
    write('untracked.txt', 'kept\n')
    const inspected = await continueRebase(repoPath, 'inspect')
    expect(inspected).toMatchObject({ abortWouldDiscard: ['a.txt'], abortBlockedBy: [] })

    await expect(
      continueRebase(repoPath, 'abort', {
        expected: inspected.stop,
        expectedDiscards: inspected.abortWouldDiscard
      })
    ).resolves.toEqual({ outcome: 'aborted' })
    expect(git('status', '--porcelain')).toBe('?? untracked.txt\n')
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('remove-a')
  })
})
