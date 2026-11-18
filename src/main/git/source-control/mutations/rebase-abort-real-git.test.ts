import { appendFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { abortRebase, detectConflictOperation } from './git-conflict-operation'
import { continueRebase } from './rebase-continue'
import { createConflictingRebaseRepo } from './rebase-real-git.test-fixture'

describe('rebase Abort against real git', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  /** Paused on a pick that conflicts in a.txt and cleanly adds d.txt; c.txt is only main's. */
  function pausedRebase(config: Record<string, string> = {}) {
    const repo = createConflictingRebaseRepo(tempPaths)
    const { git, write } = repo
    for (const [key, value] of Object.entries(config)) {
      git('config', key, value)
    }
    git('checkout', '--quiet', '-b', 'pick', 'main~1')
    write('a.txt', 'pick a\n')
    write('d.txt', 'pick d\n')
    git('add', 'a.txt', 'd.txt')
    git('commit', '--quiet', '-m', 'pick a and d')
    expect(() => git('rebase', 'main')).toThrow()
    const snapshot = () =>
      git('diff', 'HEAD', '--binary') +
      git('diff', '--cached', '--binary') +
      readFileSync(join(repo.repoPath, 'a.txt'), 'utf8')
    return { ...repo, snapshot }
  }

  async function abortAtCurrentStop(repoPath: string) {
    const { stop } = await continueRebase(repoPath, 'inspect')
    return continueRebase(repoPath, 'abort', { expected: stop })
  }

  async function expectRefused(
    repo: ReturnType<typeof pausedRebase>,
    abortSafety: unknown
  ): Promise<void> {
    const before = repo.snapshot()
    await expect(continueRebase(repo.repoPath, 'inspect')).resolves.toMatchObject({ abortSafety })
    await expect(abortAtCurrentStop(repo.repoPath)).resolves.toMatchObject({
      outcome: 'abort_blocked',
      abortSafety
    })
    await expect(abortRebase(repo.repoPath)).rejects.toThrow()
    await expect(detectConflictOperation(repo.repoPath)).resolves.toBe('rebase')
    expect(repo.snapshot()).toBe(before)
  }

  it.each(['merge', 'zdiff3'])(
    'aborts a pristine conflict (%s style) with a cleanly applied pick file',
    async (style) => {
      const { repoPath, git } = pausedRebase({ 'merge.conflictStyle': style })
      await expect(continueRebase(repoPath, 'inspect')).resolves.toMatchObject({
        abortSafety: { kind: 'pristine' }
      })
      await expect(abortAtCurrentStop(repoPath)).resolves.toEqual({ outcome: 'aborted' })
      expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pick')
    }
  )

  it('aborts a pristine conflict through the older abort entry point', async () => {
    const { repoPath } = pausedRebase()
    await abortRebase(repoPath)
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
  })

  it('refuses a tail edit in a conflicted pick file', async () => {
    const repo = pausedRebase()
    appendFileSync(join(repo.repoPath, 'a.txt'), 'my own line\n')
    await expectRefused(repo, { kind: 'edits', files: ['a.txt'] })
  })

  it('refuses a resolved pick file, staged, with a worktree tail edit on top', async () => {
    const repo = pausedRebase()
    repo.write('a.txt', 'resolved a\n')
    repo.git('add', 'a.txt')
    appendFileSync(join(repo.repoPath, 'a.txt'), 'my own line\n')
    await expectRefused(repo, { kind: 'edits', files: ['a.txt'] })
  })

  it('refuses a staged tail edit in a cleanly applied pick file', async () => {
    const repo = pausedRebase()
    appendFileSync(join(repo.repoPath, 'd.txt'), 'my own line\n')
    repo.git('add', 'd.txt')
    await expectRefused(repo, { kind: 'edits', files: ['d.txt'] })
  })

  it('refuses an unrelated edit, staged, unstaged or cancelled out', async () => {
    const repo = pausedRebase()
    repo.write('c.txt', 'staged c\n')
    repo.git('add', 'c.txt')
    repo.write('c.txt', 'main c\n')
    await expectRefused(repo, { kind: 'edits', files: ['c.txt'] })
  })

  // Windows forbids these characters in file names.
  it.skipIf(process.platform === 'win32')('names pathspec-like files exactly', async () => {
    const repo = pausedRebase()
    repo.write(':(top)x', 'new\n')
    repo.write('*', 'new\n')
    repo.git('add', '--', ':(literal):(top)x', ':(literal)*')
    await expectRefused(repo, { kind: 'edits', files: ['*', ':(top)x'] })
  })

  it('aborts a pristine modify/delete conflict', async () => {
    const { repoPath, git, write } = createConflictingRebaseRepo(tempPaths)
    git('checkout', '--quiet', '-b', 'remove-a', 'main~1')
    git('rm', '--quiet', 'a.txt')
    git('commit', '--quiet', '-m', 'remove a')
    expect(() => git('rebase', 'main')).toThrow()
    write('untracked.txt', 'kept\n')
    await expect(abortAtCurrentStop(repoPath)).resolves.toEqual({ outcome: 'aborted' })
    expect(git('status', '--porcelain')).toBe('?? untracked.txt\n')
  })

  it('refuses a resolution rerere replayed', async () => {
    const repo = pausedRebase({ 'rerere.enabled': 'true' })
    repo.write('a.txt', 'resolved a\n')
    repo.git('add', 'a.txt')
    repo.git('rebase', '--continue')
    repo.git('reset', '--quiet', '--hard', 'ORIG_HEAD')
    expect(() => repo.git('rebase', 'main')).toThrow()
    expect(readFileSync(join(repo.repoPath, 'a.txt'), 'utf8')).toBe('resolved a\n')
    await expectRefused(repo, { kind: 'edits', files: ['a.txt'] })
  })

  it('refuses when a custom merge driver produced the conflict', async () => {
    const repo = createConflictingRebaseRepo(tempPaths)
    repo.write('.git/info/attributes', 'a.txt merge=custom\n')
    repo.git('config', 'merge.custom.driver', 'false')
    expect(() => repo.git('rebase', 'main')).toThrow()
    const before = repo.git('diff', 'HEAD', '--binary')
    await expect(abortAtCurrentStop(repo.repoPath)).resolves.toMatchObject({
      outcome: 'abort_blocked',
      abortSafety: { kind: 'unverifiable' }
    })
    expect(repo.git('diff', 'HEAD', '--binary')).toBe(before)
  })

  const readRaw = (repoPath: string, file: string) => readFileSync(join(repoPath, file), 'utf8')

  // The filter command is POSIX sed.
  it.skipIf(process.platform === 'win32')(
    'refuses when a clean filter would hide worktree bytes Abort rewrites',
    async () => {
      const repo = pausedRebase({
        'filter.strip.clean': "sed '/LOCAL/d'",
        'filter.strip.smudge': 'cat'
      })
      repo.write('.git/info/attributes', 'c.txt filter=strip\n')
      repo.write('c.txt', 'main c\nLOCAL note\n')
      await expectRefused(repo, { kind: 'unverifiable' })
      expect(readRaw(repo.repoPath, 'c.txt')).toBe('main c\nLOCAL note\n')
    }
  )

  it('refuses when line-ending conversion is configured', async () => {
    const repo = pausedRebase({ 'core.autocrlf': 'input' })
    await expectRefused(repo, { kind: 'unverifiable' })
  })

  it('refuses when an assume-unchanged pick file hides a worktree edit', async () => {
    const repo = pausedRebase()
    repo.git('update-index', '--assume-unchanged', 'd.txt')
    appendFileSync(join(repo.repoPath, 'd.txt'), 'my own line\n')
    await expectRefused(repo, { kind: 'unverifiable' })
    expect(readRaw(repo.repoPath, 'd.txt')).toBe('pick d\nmy own line\n')
  })

  it('refuses when a skip-worktree file hides a worktree edit', async () => {
    const repo = pausedRebase()
    repo.git('update-index', '--skip-worktree', 'c.txt')
    repo.write('c.txt', 'my own c\n')
    await expectRefused(repo, { kind: 'unverifiable' })
    expect(readRaw(repo.repoPath, 'c.txt')).toBe('my own c\n')
  })

  it('refuses when it cannot read the stopped pick', async () => {
    const repo = pausedRebase()
    unlinkSync(join(repo.repoPath, '.git', 'REBASE_HEAD'))
    await expectRefused(repo, { kind: 'unverifiable' })
  })

  it('re-asks instead of aborting a stop the user was not shown', async () => {
    const { repoPath } = pausedRebase()
    await expect(
      continueRebase(repoPath, 'abort', {
        expected: { head: 'other', step: '1', incarnation: 'other' }
      })
    ).resolves.toMatchObject({ outcome: 'abort_changed', abortSafety: { kind: 'pristine' } })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
  })
})
