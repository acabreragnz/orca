import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  ContinueRebaseResult,
  RebaseStopToken
} from '../../../../../../shared/git/status/git-status-types'

export type AbortConfirmRequest = {
  title: string
  description: string
  confirmLabel: string
  confirmVariant: 'destructive'
}

/**
 * What the host proved Abort would reset: discards (the stopped pick's own files) and blockedBy
 * (other tracked edits). Null when it could not say (older host, unreadable).
 */
export type RebaseAbortEvidence = {
  stop: RebaseStopToken
  discards: string[]
  blockedBy: string[]
} | null

const LISTED_FILE_LIMIT = 3

function listFiles(files: string[]): string {
  const listed = files.slice(0, LISTED_FILE_LIMIT).join(', ')
  const hidden = files.length - LISTED_FILE_LIMIT
  return hidden > 0
    ? translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseDiscardFilesMore',
        '{{files}} and {{count}} more',
        { files: listed, count: hidden }
      )
    : listed
}

function abortRebaseDialog(discards: string[]): AbortConfirmRequest {
  if (discards.length === 0) {
    return {
      title: translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseConfirmTitle',
        'Abort rebase?'
      ),
      description: translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseConfirmDescription',
        'This cancels the rebase in progress and can discard conflict resolutions made during this rebase.'
      ),
      confirmLabel: translate(
        'auto.components.right.sidebar.SourceControl.425f138269',
        'Abort rebase'
      ),
      confirmVariant: 'destructive'
    }
  }
  return {
    title: translate(
      'auto.components.right.sidebar.SourceControl.abortRebaseDiscardTitle',
      'Abort rebase and discard edits to {{count}} files?',
      {
        count: discards.length,
        defaultValue_one: 'Abort rebase and discard edits to {{count}} file?'
      }
    ),
    description: listFiles(discards),
    confirmLabel: translate(
      'auto.components.right.sidebar.SourceControl.abortRebaseDiscardConfirm',
      'Discard and abort'
    ),
    confirmVariant: 'destructive'
  }
}

export function rebaseAbortEvidence(result: ContinueRebaseResult): RebaseAbortEvidence {
  return result.stop && result.abortWouldDiscard && result.abortBlockedBy
    ? { stop: result.stop, discards: result.abortWouldDiscard, blockedBy: result.abortBlockedBy }
    : null
}

/** Abort only undoes the rebase: other tracked edits, or edits it could not check, refuse it. */
export function showRebaseAbortRefused(blockedBy: string[] | null): void {
  if (blockedBy === null) {
    toast.error(
      translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseEditsUnchecked',
        "Couldn't check your edits, so the rebase wasn't aborted."
      )
    )
    return
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.SourceControl.abortRebaseOtherEditsFirst',
      'Commit or stash your other edits first.'
    ),
    { description: listFiles(blockedBy) }
  )
}

/**
 * Abort only undoes the rebase. Other tracked edits, or unreadable evidence, refuse it; otherwise
 * the dialog names the pick's own edits it discards. The host rechecks under its lock and returns
 * fresh evidence if anything changed, so this asks again or refuses.
 */
export async function confirmAndAbortRebase({
  inspect,
  confirm,
  refuse,
  beginAbort,
  abort
}: {
  inspect: () => Promise<RebaseAbortEvidence>
  confirm: (request: AbortConfirmRequest) => Promise<boolean>
  refuse: (blockedBy: string[] | null) => void
  beginAbort: () => void
  abort: (stop: RebaseStopToken, discards: string[]) => Promise<ContinueRebaseResult>
}): Promise<ContinueRebaseResult | 'cancelled' | 'refused'> {
  let evidence = await inspect()
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!evidence || evidence.blockedBy.length > 0) {
      refuse(evidence?.blockedBy ?? null)
      return 'refused'
    }
    if (!(await confirm(abortRebaseDialog(evidence.discards)))) {
      return 'cancelled'
    }
    beginAbort()
    const result = await abort(evidence.stop, evidence.discards)
    if (result.outcome !== 'abort_changed' && result.outcome !== 'abort_blocked') {
      return result
    }
    evidence = rebaseAbortEvidence(result)
  }
  return 'cancelled'
}
