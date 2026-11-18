import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'

/**
 * What git rebase --abort would reset. discards: changed tracked paths the stopped pick owns (its
 * own files or Git's unmerged ones), i.e. the rebase's resolution. blockedBy: any other changed
 * tracked path, which Abort must not discard. Null when Git cannot say.
 */
export type RebaseAbortPaths = { discards: string[]; blockedBy: string[] }

export async function readRebaseAbortPaths(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<RebaseAbortPaths | null> {
  const gitOptions = gitOptionsForWorktree(worktreePath, options)
  try {
    // Separately, so staged content an unstaged edit cancels out is still named; -z keeps names exact.
    const staged = await gitExecFileAsync(
      ['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD', '--'],
      gitOptions
    )
    const unstaged = await gitExecFileAsync(
      ['diff', '--name-only', '-z', '--no-renames', '--'],
      gitOptions
    )
    const changed = [...new Set([...splitNul(staged.stdout), ...splitNul(unstaged.stdout)])].sort()
    if (changed.length === 0) {
      return { discards: [], blockedBy: [] }
    }
    const pick = await gitExecFileAsync(
      [
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '-r',
        '-z',
        '--no-renames',
        'REBASE_HEAD',
        '--'
      ],
      gitOptions
    )
    const unmerged = await gitExecFileAsync(['ls-files', '-u', '-z'], gitOptions)
    const owned = new Set([
      ...splitNul(pick.stdout),
      // Entries are "<mode> <oid> <stage>\t<path>".
      ...splitNul(unmerged.stdout).map((entry) => entry.slice(entry.indexOf('\t') + 1))
    ])
    return {
      discards: changed.filter((file) => owned.has(file)),
      blockedBy: changed.filter((file) => !owned.has(file))
    }
  } catch {
    return null
  }
}

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0)
}

export function joinGitOutput(stdout: unknown, stderr: unknown): string {
  return [stdout, stderr]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join('\n')
}

// Keep Git's diagnostics; spawn failures carry only an Error message.
export function readGitErrorOutput(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const output = joinGitOutput(
      'stdout' in error ? error.stdout : undefined,
      'stderr' in error ? error.stderr : undefined
    )
    if (output) {
      return output
    }
  }
  return error instanceof Error ? error.message : String(error)
}
