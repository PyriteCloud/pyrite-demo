// ─── Message types ────────────────────────────────────────────────────────────

type StartMessage = {
  type: 'START'
  concurrency: number
  url: string
  timeoutMs: number
}

type StopMessage = {
  type: 'STOP'
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

type WorkerInMessage = StartMessage | StopMessage

// ─── State ────────────────────────────────────────────────────────────────────

let activeLoops = 0
let runController: AbortController | null = null

// ─── Helpers ──────────────────────────────────────────────────────────────────

function postState(targetConcurrency: number) {
  self.postMessage({
    type: 'STATE',
    inflight: activeLoops,
    activeLoops,
    targetConcurrency
  } satisfies StateMessage)
}

function stopAllLoops() {
  runController?.abort()
  runController = null
  activeLoops = 0
}

// ─── Request loop ─────────────────────────────────────────────────────────────

async function requestLoop(
  url: string,
  timeoutMs: number,
  signal: AbortSignal
) {
  activeLoops++

  try {
    while (!signal.aborted) {
      const startedAt = performance.now()

      try {
        const urlWithTimestamp = `${url}?t=${Date.now() + Math.random()}`
        const response = await fetch(urlWithTimestamp, {
          cache: 'no-store',
          keepalive: true,
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
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
        if (signal.aborted) break

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

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data

  if (msg.type === 'STOP') {
    stopAllLoops()
    postState(0)
    return
  }

  if (msg.type !== 'START') return

  // Cancel any loops from the previous run before starting fresh
  stopAllLoops()

  const concurrency = Math.max(0, Math.floor(msg.concurrency))

  if (concurrency === 0) {
    postState(0)
    return
  }

  runController = new AbortController()
  const { signal } = runController

  for (let i = 0; i < concurrency; i++) {
    void requestLoop(msg.url, msg.timeoutMs, signal)
  }

  postState(concurrency)
}
