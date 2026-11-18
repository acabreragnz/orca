import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  ContinueRebaseResult,
  RebaseAbortSafety,
  RebaseStopToken
} from '../../../../../../shared/git/status/git-status-types'

export type AbortConfirmRequest = {
  title: string
  description: string
  confirmLabel: string
  confirmVariant: 'destructive'
}

/** The stop the host read and whether Abort there loses anything; null when it could not say. */
export type RebaseAbortEvidence = { stop: RebaseStopToken; safety: RebaseAbortSafety } | null

const LISTED_FILE_LIMIT = 3

function abortRebaseDialog(): AbortConfirmRequest {
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

export function rebaseAbortEvidence(result: ContinueRebaseResult): RebaseAbortEvidence {
  return result.stop && result.abortSafety
    ? { stop: result.stop, safety: result.abortSafety }
    : null
}

/** Abort only undoes the rebase: the user's edits, or edits it could not check, refuse it. */
export function showRebaseAbortRefused(safety: RebaseAbortSafety | null): void {
  if (safety?.kind === 'edits') {
    toast.error(
      translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseWouldDiscardEdits',
        'Abort would discard your edits to {{count}} files. Undo them or finish with Continue.',
        {
          count: safety.files.length,
          defaultValue_one:
            'Abort would discard your edits to {{count}} file. Undo them or finish with Continue.'
        }
      ),
      { description: listFiles(safety.files) }
    )
    return
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.SourceControl.abortRebaseCantVerify',
      "Can't confirm Abort is safe here. Finish with Continue or abort in a terminal."
    )
  )
}

/**
 * Abort only runs when the host proved it loses nothing of the user's; otherwise it is refused
 * without asking. The host repeats the check under its lock, so this re-asks if the stop moved and
 * refuses if the recheck found edits.
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
  refuse: (safety: RebaseAbortSafety | null) => void
  beginAbort: () => void
  abort: (stop: RebaseStopToken) => Promise<ContinueRebaseResult>
}): Promise<ContinueRebaseResult | 'cancelled' | 'refused'> {
  let evidence = await inspect()
  for (let attempt = 0; attempt < 3; attempt++) {
    if (evidence?.safety.kind !== 'pristine') {
      refuse(evidence?.safety ?? null)
      return 'refused'
    }
    if (!(await confirm(abortRebaseDialog()))) {
      return 'cancelled'
    }
    beginAbort()
    const result = await abort(evidence.stop)
    if (result.outcome !== 'abort_changed' && result.outcome !== 'abort_blocked') {
      return result
    }
    evidence = rebaseAbortEvidence(result)
  }
  return 'cancelled'
}
