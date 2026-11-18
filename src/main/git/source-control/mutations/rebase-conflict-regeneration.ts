import { gitExecFileAsync } from '../../command-runner/git-exec-file'

type GitExecOptions = Parameters<typeof gitExecFileAsync>[1]

export const ZERO_MODE = '000000'

/** A state whose Abort outcome cannot be proven safe; the check reports it as unverifiable. */
export class Unverifiable extends Error {}

export type UnmergedEntry = {
  kind: 'unmerged'
  sub: string
  modes: string[]
  stages: string[]
  path: string
}

/** The labels the merge backend writes for a pick: HEAD, "<short> (<subject>)" and its parent. */
export async function readConflictLabels(pick: string, git: GitExecOptions): Promise<string[]> {
  const short = (await gitExecFileAsync(['rev-parse', '--short', pick], git)).stdout.trim()
  const message = (await gitExecFileAsync(['log', '-1', '--format=%B', pick], git)).stdout
  const subject = `${short} (${message.split('\n')[0]})`
  return ['HEAD', `parent of ${subject}`, subject]
}

export type MergeAttributes = { markerSize: string | null }

/** Only Git's built-in text merge is reproducible: no custom driver, encoding or default driver. */
export async function readMergeAttributes(
  paths: string[],
  git: GitExecOptions
): Promise<Map<string, MergeAttributes>> {
  if (
    (await readConfig('merge.default', git)) !== null ||
    (await readConfig('merge.renormalize', git)) === 'true'
  ) {
    throw new Unverifiable('merge config')
  }
  const { stdout } = await gitExecFileAsync(
    ['check-attr', '-z', 'merge', 'working-tree-encoding', 'conflict-marker-size', '--', ...paths],
    git
  )
  const fields = stdout.split('\0')
  const attributes = new Map<string, MergeAttributes>()
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [file, name, value] = [fields[i], fields[i + 1], fields[i + 2]]
    const current = attributes.get(file) ?? { markerSize: null }
    if (name === 'conflict-marker-size' && value !== 'unspecified') {
      if (!/^\d+$/.test(value)) {
        throw new Unverifiable(file)
      }
      current.markerSize = value
    } else if (name !== 'conflict-marker-size' && value !== 'unspecified') {
      throw new Unverifiable(file)
    }
    attributes.set(file, current)
  }
  return attributes
}

export async function conflictIsPristine(
  entry: UnmergedEntry,
  labels: string[],
  attributes: MergeAttributes | undefined,
  git: GitExecOptions
): Promise<boolean> {
  const [base, ours, theirs] = entry.stages
  const [modeBase, modeOurs, modeTheirs, modeWorktree] = entry.modes
  const present = entry.modes.slice(0, 3).filter((mode) => mode !== ZERO_MODE)
  if (new Set([...present, modeWorktree]).size !== 1) {
    // Mixed modes, or the worktree file is gone or changed mode.
    return modeWorktree === ZERO_MODE ? false : unverifiable(entry.path)
  }
  const worktree = (
    await gitExecFileAsync(['hash-object', '--no-filters', '--', entry.path], git)
  ).stdout.trim()
  if (modeBase !== ZERO_MODE && (modeOurs === ZERO_MODE) !== (modeTheirs === ZERO_MODE)) {
    // Modify/delete: Git leaves the surviving side as it was.
    return worktree === (modeOurs === ZERO_MODE ? theirs : ours)
  }
  if (modeBase === ZERO_MODE || modeOurs === ZERO_MODE) {
    return unverifiable(entry.path)
  }
  const regenerated = await mergeStages(
    ours,
    base,
    theirs,
    labels,
    attributes?.markerSize ?? null,
    git
  )
  // Binary files get no markers; Git keeps our side.
  return worktree === (regenerated ?? ours)
}

/** Git's conflict output for the stages, as a blob id; null when Git won't merge them (binary). */
async function mergeStages(
  ours: string,
  base: string,
  theirs: string,
  labels: string[],
  markerSize: string | null,
  git: GitExecOptions
): Promise<string | null> {
  const args = [
    'merge-file',
    '--object-id',
    '--diff-algorithm=histogram',
    ...(markerSize ? [`--marker-size=${markerSize}`] : []),
    ...labels.flatMap((label) => ['-L', label]),
    ours,
    base,
    theirs
  ]
  try {
    return (await gitExecFileAsync(args, git)).stdout.trim()
  } catch (error) {
    // Exit code = number of conflicts, with the merged blob still written and printed.
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error
        ? String(error.stdout).trim()
        : ''
    if (typeof code === 'number' && code > 0 && code < 128 && /^[0-9a-f]{40,64}$/.test(stdout)) {
      return stdout
    }
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
    if (/binary/i.test(stderr)) {
      return null
    }
    throw new Unverifiable('merge-file')
  }
}

function unverifiable(file: string): never {
  throw new Unverifiable(file)
}

async function readConfig(key: string, git: GitExecOptions): Promise<string | null> {
  try {
    return (await gitExecFileAsync(['config', '--get', key], git)).stdout.trim() || null
  } catch {
    return null
  }
}
