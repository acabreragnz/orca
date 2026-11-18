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

/** What the host proved Abort would reset; null when it could not say (older host, unreadable). */
export type RebaseAbortEvidence = { stop: RebaseStopToken; discards: string[] } | null

const LISTED_FILE_LIMIT = 3

function abortRebaseDialog(discards: string[] | null): AbortConfirmRequest {
  const discardLabel = translate(
    'auto.components.right.sidebar.SourceControl.abortRebaseDiscardConfirm',
    'Discard and abort'
  )
  if (discards === null) {
    return {
      title: translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseConfirmTitle',
        'Abort rebase?'
      ),
      description: translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseMayLoseEdits',
        'Uncommitted edits may be lost.'
      ),
      confirmLabel: discardLabel,
      confirmVariant: 'destructive'
    }
  }
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
  const listed = discards.slice(0, LISTED_FILE_LIMIT).join(', ')
  const hidden = discards.length - LISTED_FILE_LIMIT
  return {
    title: translate(
      'auto.components.right.sidebar.SourceControl.abortRebaseDiscardTitle',
      'Abort rebase and discard edits to {{count}} files?',
      {
        count: discards.length,
        defaultValue_one: 'Abort rebase and discard edits to {{count}} file?'
      }
    ),
    description:
      hidden > 0
        ? translate(
            'auto.components.right.sidebar.SourceControl.abortRebaseDiscardFilesMore',
            '{{files}} and {{count}} more',
            { files: listed, count: hidden }
          )
        : listed,
    confirmLabel: discardLabel,
    confirmVariant: 'destructive'
  }
}

export function rebaseAbortEvidence(result: ContinueRebaseResult): RebaseAbortEvidence {
  return result.stop && result.abortWouldDiscard
    ? { stop: result.stop, discards: result.abortWouldDiscard }
    : null
}

/**
 * Abort resets every tracked path, so the dialog names them (or says it cannot tell). The host
 * backs those edits up before aborting, and refuses if the confirmed stop or set changed; then ask
 * again. Unknown evidence sends no binding, after the user accepted that edits may be losts.
 */
export async function confirmAndAbortRebase({
  inspect,
  confirm,
  beginAbort,
  abort
}: {
  inspect: () => Promise<RebaseAbortEvidence>
  confirm: (request: AbortConfirmRequest) => Promise<boolean>
  beginAbort: () => void
  abort: (stop?: RebaseStopToken, discards?: string[]) => Promise<ContinueRebaseResult>
}): Promise<ContinueRebaseResult | 'cancelled'> {
  let evidence = await inspect()
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await confirm(abortRebaseDialog(evidence?.discards ?? null)))) {
      return 'cancelled'
    }
    beginAbort()
    const result = evidence ? await abort(evidence.stop, evidence.discards) : await abort()
    if (result.outcome !== 'abort_changed') {
      return result
    }
    evidence = rebaseAbortEvidence(result)
  }
  return 'cancelled'
}
