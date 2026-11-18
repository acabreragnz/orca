import { useEffect } from 'react'
import type { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'

type Transport = ReturnType<typeof useStructuredAgentSessionTransportState>

/** QA-DIAG (never merge): one console line per committed frame that holds a queued message. */
export function useQaDiagQueueLog(
  state: { working?: boolean; nextQueuedMessageId?: string | null },
  transport: Transport
): void {
  const hostWorking = state.working
  const next = state.nextQueuedMessageId ?? null
  const { isWorking, queueSendsNext, queuePause, queuedMessages } = transport
  useEffect(() => {
    if (!queuedMessages?.length) {
      return
    }
    const queued = queuedMessages.map((m) => ({
      id: m.messageId,
      steers: m.steers ?? false,
      state: m.state,
      held: m.paused ?? false
    }))
    const paused = queuePause !== null
    const line = {
      t: performance.now(),
      hostWorking,
      isWorking,
      queueSendsNext,
      next,
      paused,
      queued
    }
    console.info(`QA-DIAG ${JSON.stringify(line)}`)
  }, [hostWorking, isWorking, queueSendsNext, next, queuePause, queuedMessages])
}
