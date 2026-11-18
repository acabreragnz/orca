import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'

/** Every tracked path Abort would reset, staged and unstaged listed separately; null when unknown. */
export async function readTrackedPathsAbortWouldReset(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string[] | null> {
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
    return [...new Set([...splitNul(staged.stdout), ...splitNul(unstaged.stdout)])].sort()
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
