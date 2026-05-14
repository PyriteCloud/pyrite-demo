type StartMessage = {
  type: 'START'
  concurrency: number
  url: string
  timeoutMs: number
}

type ResultMessage = {
  type: 'RESULT'
  success: boolean
  data?: unknown
  latencyMs?: number
  inflight?: number
}

type StateMessage = {
  type: 'STATE'
  inflight: number
  activeLoops: number
  targetConcurrency: number
}

type WorkerMessage = StartMessage | ResultMessage | StateMessage

let activeLoops = 0

function postState(targetConcurrency: number) {
  self.postMessage({
    type: 'STATE',
    inflight: activeLoops,
    activeLoops,
    targetConcurrency
  } satisfies StateMessage)
}

async function requestLoop(url: string, timeoutMs: number) {
  activeLoops += 1

  try {
    while (true) {
      const startedAt = performance.now()

      try {
        const response = await fetch(url, {
          cache: 'no-store',
          keepalive: true,
          signal: AbortSignal.timeout(timeoutMs)
        })

        const latencyMs = performance.now() - startedAt

        let data: unknown = null
        try {
          data = await response.json()
        } catch {
          data = null
        }

        self.postMessage({
          type: 'RESULT',
          success: response.ok,
          data: response.ok ? data : null,
          latencyMs,
          inflight: activeLoops
        } satisfies ResultMessage)
      } catch {
        self.postMessage({
          type: 'RESULT',
          success: false,
          inflight: activeLoops
        } satisfies ResultMessage)
      }
    }
  } finally {
    activeLoops = Math.max(0, activeLoops - 1)
  }
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data

  if (msg.type !== 'START') return

  const concurrency = Math.max(0, Math.floor(msg.concurrency))
  if (concurrency <= 0) {
    activeLoops = 0
    postState(0)
    return
  }

  for (let i = 0; i < concurrency; i++) {
    void requestLoop(msg.url, msg.timeoutMs)
  }

  postState(concurrency)
}
