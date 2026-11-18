import { access } from 'node:fs/promises'
import * as path from 'node:path'
import type { RebaseAbortSafety } from '../../../../shared/git/status/git-status-types'
import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'
import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { resolveGitDir } from '../resolve-git-dir'
import { forgetOrcaRebaseProvenance } from './orca-rebase-provenance'
import {
  conflictIsPristine,
  readConflictLabels,
  readMergeAttributes,
  Unverifiable,
  ZERO_MODE,
  type UnmergedEntry
} from './rebase-conflict-regeneration'

type GitExecOptions = Parameters<typeof gitExecFileAsync>[1]
type TreeEntry = { mode: string; oid: string }

const REGULAR_MODES = new Set(['100644', '100755'])

/**
 * Abort may only undo the rebase. It is safe when every changed tracked path is byte-for-byte what
 * Git itself produced at this stop: a cleanly applied pick file (index = picked blob, HEAD = its
 * parent's blob, worktree = index), or a conflicted file whose worktree equals Git's conflict
 * output regenerated from the index stages. Anything else is an edit Abort would lose; anything
 * this cannot reproduce (drivers, encodings, submodules, symlinks, the apply backend) is refused.
 */
export async function checkRebaseAbortSafety(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<RebaseAbortSafety> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
  if (process.platform === 'win32') {
    addWslEnvKeys(env, ['GIT_LITERAL_PATHSPECS'])
  }
  const git = { ...gitOptionsForWorktree(worktreePath, options), env }
  try {
    const { stdout } = await gitExecFileAsync(
      ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--no-renames', '-uno'],
      git
    )
    const entries = parseStatus(stdout)
    if (entries.length === 0) {
      return { kind: 'pristine' }
    }
    const edits = await findEdits(worktreePath, entries, git, options)
    return edits.length > 0 ? { kind: 'edits', files: edits.sort() } : { kind: 'pristine' }
  } catch {
    return { kind: 'unverifiable' }
  }
}

type StatusEntry =
  | {
      kind: 'changed'
      xy: string
      sub: string
      modes: string[]
      head: string
      index: string
      path: string
    }
  | UnmergedEntry

function parseStatus(stdout: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  for (const record of stdout.split('\0')) {
    if (record.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = splitFields(record, 8)
      entries.push({
        kind: 'changed',
        xy: fields[1],
        sub: fields[2],
        modes: fields.slice(3, 6),
        head: fields[6],
        index: fields[7],
        path: fields[8]
      })
    } else if (record.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = splitFields(record, 10)
      entries.push({
        kind: 'unmerged',
        sub: fields[2],
        modes: fields.slice(3, 7),
        stages: fields.slice(7, 10),
        path: fields[10]
      })
    } else if (record.length > 0) {
      // Renames are off and untracked files are excluded; anything else is unexpected.
      throw new Unverifiable(record)
    }
  }
  return entries
}

/** The first `count` space-separated fields, then the path (which may contain spaces). */
function splitFields(record: string, count: number): string[] {
  const fields: string[] = []
  let rest = record
  for (let i = 0; i < count; i++) {
    const space = rest.indexOf(' ')
    if (space === -1) {
      throw new Unverifiable(record)
    }
    fields.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  fields.push(rest)
  return fields
}

async function findEdits(
  worktreePath: string,
  entries: StatusEntry[],
  git: GitExecOptions,
  options: GitRuntimeOptions
): Promise<string[]> {
  for (const entry of entries) {
    if (
      entry.sub !== 'N...' ||
      entry.modes.some((mode) => mode !== ZERO_MODE && !REGULAR_MODES.has(mode))
    ) {
      throw new Unverifiable(entry.path)
    }
  }
  const gitDir = await resolveGitDir(worktreePath, options)
  // A strategy or its options change Git's merge output in ways this does not reproduce.
  for (const file of ['rebase-merge/strategy', 'rebase-merge/strategy_opts']) {
    if (await exists(path.join(gitDir, file))) {
      throw new Unverifiable(file)
    }
  }
  const pick = (
    await gitExecFileAsync(['rev-parse', '--verify', 'REBASE_HEAD^{commit}'], git)
  ).stdout.trim()
  const parent = await revParseOrNull(`${pick}^`, git)
  const changed = entries.filter((entry) => entry.kind === 'changed')
  const unmerged = entries.filter((entry) => entry.kind === 'unmerged')
  const paths = changed.map((entry) => entry.path)
  const picked = await readTreeEntries(pick, paths, git)
  const parentEntries = parent
    ? await readTreeEntries(parent, paths, git)
    : new Map<string, TreeEntry>()

  const edits: string[] = []
  for (const entry of changed) {
    // A cleanly applied pick file: worktree = index = picked blob, and HEAD = the pick's parent.
    const [modeHead, modeIndex, modeWorktree] = entry.modes
    const owned =
      entry.xy[0] !== '.' &&
      entry.xy[1] === '.' &&
      modeIndex === modeWorktree &&
      sameEntry({ mode: modeIndex, oid: entry.index }, picked.get(entry.path)) &&
      sameEntry({ mode: modeHead, oid: entry.head }, parentEntries.get(entry.path))
    if (!owned) {
      edits.push(entry.path)
    }
  }
  if (unmerged.length > 0) {
    if (await exists(path.join(gitDir, 'rebase-apply'))) {
      throw new Unverifiable('apply backend')
    }
    const labels = await readConflictLabels(pick, git)
    const attributes = await readMergeAttributes(
      unmerged.map((entry) => entry.path),
      git
    )
    for (const entry of unmerged) {
      if (!(await conflictIsPristine(entry, labels, attributes.get(entry.path), git))) {
        edits.push(entry.path)
      }
    }
  }
  return edits
}

function sameEntry(entry: TreeEntry, tree: TreeEntry | undefined): boolean {
  return entry.mode === ZERO_MODE
    ? tree === undefined
    : tree?.mode === entry.mode && tree.oid === entry.oid
}

async function readTreeEntries(
  commit: string,
  paths: string[],
  git: GitExecOptions
): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>()
  if (paths.length === 0) {
    return entries
  }
  // GIT_LITERAL_PATHSPECS keeps names like ':(top)x' or '*' literal.
  const { stdout } = await gitExecFileAsync(
    ['ls-tree', '-z', '--full-tree', commit, '--', ...paths],
    git
  )
  for (const record of stdout.split('\0').filter(Boolean)) {
    // <mode> SP <type> SP <oid> TAB <path>
    const tab = record.indexOf('\t')
    const [mode, , oid] = record.slice(0, tab).split(' ')
    entries.set(record.slice(tab + 1), { mode, oid })
  }
  return entries
}

async function revParseOrNull(rev: string, git: GitExecOptions): Promise<string | null> {
  try {
    return (await gitExecFileAsync(['rev-parse', '--verify', '-q', rev], git)).stdout.trim() || null
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** Runs git rebase --abort only when the check proves it loses nothing. The caller holds the lock. */
export async function abortRebaseIfSafeUnlocked(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<RebaseAbortSafety> {
  const safety = await checkRebaseAbortSafety(worktreePath, options)
  if (safety.kind === 'pristine') {
    forgetOrcaRebaseProvenance(worktreePath)
    await gitExecFileAsync(['rebase', '--abort'], gitOptionsForWorktree(worktreePath, options))
  }
  return safety
}

/** The host's own wording, for callers without the desktop dialog (mobile, older clients). */
export function rebaseAbortRefusalMessage(safety: RebaseAbortSafety): string {
  if (safety.kind === 'edits') {
    const count = safety.files.length
    return `Abort would discard your edits to ${count} ${count === 1 ? 'file' : 'files'}. Undo them or finish with Continue. (${safety.files.slice(0, 3).join(', ')}${count > 3 ? ` and ${count - 3} more` : ''})`
  }
  return "Can't confirm Abort is safe here. Finish with Continue or abort in a terminal."
}
