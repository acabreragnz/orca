import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { Unverifiable } from './rebase-conflict-regeneration'

type GitExecOptions = Parameters<typeof gitExecFileAsync>[1]

// Attributes whose conversion can make worktree bytes differ from what Git compares.
const CONVERSION_ATTRIBUTES = ['filter', 'text', 'eol', 'ident', 'working-tree-encoding']
const CHECK_ATTR_BATCH = 500
const FALSE_VALUES = new Set(['false', 'no', 'off', '0'])

/**
 * Status can only be trusted to show every worktree edit when no index entry tells Git to skip
 * the worktree (assume-unchanged, skip-worktree) and core.ignoreStat is off. Callers run status
 * with core.fsmonitor=false, so a monitor's cached answer is never used.
 */
export async function assertStatusSeesWorktree(git: GitExecOptions): Promise<void> {
  if (isSet(await readConfig('core.ignoreStat', git))) {
    throw new Unverifiable('core.ignoreStat')
  }
  const { stdout } = await gitExecFileAsync(['ls-files', '-v', '-z'], git)
  for (const record of stdout.split('\0')) {
    // Lowercase tags mark assume-unchanged; "S" marks skip-worktree.
    if (/^[a-z]/.test(record) || record.startsWith('S ')) {
      throw new Unverifiable(record.slice(2))
    }
  }
}

/**
 * Worktree bytes are compared raw, so any configured conversion (filters, line endings, ident,
 * encodings) on a path Abort would rewrite refuses rather than risks hiding a byte difference.
 */
export async function assertNoByteConversions(paths: string[], git: GitExecOptions): Promise<void> {
  for (const key of ['core.autocrlf', 'core.eol', 'core.safecrlf']) {
    if (isSet(await readConfig(key, git))) {
      throw new Unverifiable(key)
    }
  }
  const unique = [...new Set(paths)]
  for (let start = 0; start < unique.length; start += CHECK_ATTR_BATCH) {
    const { stdout } = await gitExecFileAsync(
      [
        'check-attr',
        '-z',
        ...CONVERSION_ATTRIBUTES,
        '--',
        ...unique.slice(start, start + CHECK_ATTR_BATCH)
      ],
      git
    )
    const fields = stdout.split('\0')
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [file, name, value] = [fields[i], fields[i + 1], fields[i + 2]]
      // -text means "never convert"; anything else set may change bytes.
      if (value !== 'unspecified' && !(name === 'text' && value === 'unset')) {
        throw new Unverifiable(file)
      }
    }
  }
}

/** Paths git rebase --abort rewrites besides the changed ones: where HEAD and orig-head differ. */
export async function readAbortRewritePaths(
  gitDir: string,
  git: GitExecOptions
): Promise<string[]> {
  let origHead: string | null = null
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      origHead = (await readFile(path.join(gitDir, dir, 'orig-head'), 'utf8')).trim()
      break
    } catch {
      // Only one backend's directory exists.
    }
  }
  if (!origHead || !/^[0-9a-f]{40,64}$/.test(origHead)) {
    throw new Unverifiable('orig-head')
  }
  const { stdout } = await gitExecFileAsync(
    ['diff', '--name-only', '-z', '--no-renames', 'HEAD', origHead, '--'],
    git
  )
  return stdout.split('\0').filter((file) => file.length > 0)
}

function isSet(value: string | null): boolean {
  return value !== null && !FALSE_VALUES.has(value.toLowerCase())
}

async function readConfig(key: string, git: GitExecOptions): Promise<string | null> {
  try {
    return (await gitExecFileAsync(['config', '--get', key], git)).stdout.trim() || null
  } catch {
    return null
  }
}
