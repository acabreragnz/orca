import { useCallback } from 'react'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import { abortRuntimeGitMerge } from '@/runtime/source-control/git/runtime-git-sync-client'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { AbortConflictOperation } from '../listing/operation-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import {
  confirmAndAbortRebase,
  rebaseAbortEvidence,
  showRebaseAbortRefused,
  type AbortConfirmRequest,
  type RebaseAbortEvidence
} from './rebase-abort-confirmation'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { continueRuntimeGitRebase } from '@/runtime/source-control/git/runtime-git-rebase-client'
import type { SourceControlStatusRefresh } from './use-status-refresh'

// An older or unreachable host cannot prove what Abort resets: unknown evidence refuses Abort.
async function inspectRebaseAbort(context: RuntimeGitContext): Promise<RebaseAbortEvidence> {
  try {
    return rebaseAbortEvidence(await continueRuntimeGitRebase(context, 'inspect'))
  } catch {
    return null
  }
}

/** Throws when the host refused, so the caller reports it. */
async function abortConfirmedRebase(
  context: RuntimeGitContext,
  confirm: (request: AbortConfirmRequest) => Promise<boolean>,
  beginAbort: () => void
): Promise<void> {
  const result = await confirmAndAbortRebase({
    inspect: () => inspectRebaseAbort(context),
    confirm,
    refuse: showRebaseAbortRefused,
    beginAbort,
    abort: (expected, expectedDiscards) =>
      continueRuntimeGitRebase(context, 'abort', { expected, expectedDiscards })
  })
  if (result !== 'cancelled' && result !== 'refused' && result.outcome === 'failed') {
    throw new Error(result.message)
  }
}

export function useSourceControlConflictAbort({
  activeRepoTarget,
  activeWorktreeId,
  conflictOperation,
  operationStore,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  operationStore: SourceControlWorktreeOperationState['operationStore']
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
  const confirmAction = useConfirmationDialog()

  const handleAbortOperation = useCallback(
    async (requestedOperation: AbortConflictOperation): Promise<void> => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        conflictOperation !== requestedOperation ||
        operationStore.getState().isAbortingOperation
      ) {
        return
      }

      const isRebase = requestedOperation === 'rebase'
      // Rebase asks inside its own loop, which may re-ask if the host saw new edits.
      if (
        !isRebase &&
        !(await confirmAction({
          title: translate(
            'auto.components.right.sidebar.SourceControl.abortMergeConfirmTitle',
            'Abort merge?'
          ),
          description: translate(
            'auto.components.right.sidebar.SourceControl.abortMergeConfirmDescription',
            'This cancels the merge in progress and can discard conflict resolutions made during this merge.'
          ),
          confirmLabel: translate(
            'auto.components.right.sidebar.SourceControl.540ca8f78c',
            'Abort merge'
          ),
          confirmVariant: 'destructive'
        }))
      ) {
        return
      }
      if (operationStore.getState().isAbortingOperation) {
        return
      }

      const context = {
        // Abort on the repo owner, which may differ from the focused host.
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, activeWorktreeId)
      }
      const beginAbort = (): void =>
        operationStore.setState({ isAbortingOperation: true, remoteActionError: null })
      try {
        if (isRebase) {
          await abortConfirmedRebase(context, confirmAction, beginAbort)
        } else {
          beginAbort()
          await abortRuntimeGitMerge(context)
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : isRebase
              ? translate(
                  'auto.components.right.sidebar.SourceControl.abortRebaseFailedFallback',
                  'Failed to abort rebase'
                )
              : translate(
                  'auto.components.right.sidebar.SourceControl.abortMergeFailedFallback',
                  'Failed to abort merge'
                )
        toast.error(
          isRebase
            ? translate(
                'auto.components.right.sidebar.SourceControl.abortRebaseFailed',
                'Abort rebase failed'
              )
            : translate(
                'auto.components.right.sidebar.SourceControl.abortMergeFailed',
                'Abort merge failed'
              ),
          { description: message }
        )
        operationStore.setState({
          remoteActionError: {
            kind: isRebase ? 'abort_rebase' : 'abort_merge',
            message,
            rawError: message
          }
        })
      } finally {
        operationStore.setState({ isAbortingOperation: false })
        refreshSourceControlAfterRemoteAction({
          worktreeId: activeWorktreeId,
          refreshGitStatus: refreshActiveGitStatusAfterMutation,
          refreshBranchCompare: refreshBranchCompareRef.current,
          refreshGitHistory: refreshGitHistoryRef.current
        })
      }
    },
    [
      scope,
      activeRepoTarget,
      activeWorktreeId,
      confirmAction,
      conflictOperation,
      operationStore,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      worktreePath
    ]
  )

  const handleAbortMerge = useCallback(async (): Promise<void> => {
    await handleAbortOperation('merge')
  }, [handleAbortOperation])

  const handleAbortRebase = useCallback(async (): Promise<void> => {
    await handleAbortOperation('rebase')
  }, [handleAbortOperation])

  const handleAbortOperationForConflict = useCallback(
    (operation: GitConflictOperation): void => {
      if (operation === 'merge') {
        void handleAbortMerge()
        return
      }
      if (operation === 'rebase') {
        void handleAbortRebase()
      }
    },
    [handleAbortMerge, handleAbortRebase]
  )

  return {
    confirmAction,
    handleAbortMerge,
    handleAbortOperation,
    handleAbortOperationForConflict,
    handleAbortRebase
  }
}

export type SourceControlConflictAbort = ReturnType<typeof useSourceControlConflictAbort>
