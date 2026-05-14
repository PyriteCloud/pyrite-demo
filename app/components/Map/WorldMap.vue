<script setup lang="ts">
// biome-ignore-all lint: visualization file
import * as d3 from 'd3'
import * as topojson from 'topojson-client'
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'

import cloudflareTopology from '@/assets/cloudflare.json'
import countriesTopology from '@/assets/countries-110m.json'
import pyriteCloudTopology from '@/assets/pyrite-cloud.json'

// ─── Types ────────────────────────────────────────────────────────────────────

type Point = [number, number]

type NodePoint = {
  id: string
  name: string
  colo?: string
  region?: string
  coords: Point
  /** Pre-projected [x, y] — static, computed once at startup */
  projected: [number, number]
}

type LiveRequest = {
  id: string
  source: NodePoint
  target: NodePoint
  createdAt: number
  latencyMs: number
  pathD: string
  interpolate: (t: number) => Point
  hostname: string
  region: string
  success: boolean
}

type PodState = {
  hostname: string
  region: string
  lastSeenAt: number
  lastStatus: 'success' | 'error'
  requestCount: number
}

type InfoResponse = {
  pyrite?: { region?: string, hostname?: string }
  cloudflare?: { ray?: string | null, colo?: string | null }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WIDTH = 1400
const HEIGHT = 720

const TRACE_TTL_MS = 10_000
const MAX_TRACES = 500
const MAX_LATEST = 20

const REQUEST_TIMEOUT_MS = 1_000

const POD_IDLE_MS = 10_000
const POD_DELETE_MS = 60_000
/** How often to evict stale pods from the registry (ms). */
const POD_EVICT_INTERVAL_MS = 5_000

/** Hard cap on trace path cache size. Oldest entries are evicted first. */
const TRACE_CACHE_MAX = 500

const CLOUDFLARE_PRIMARY = '#F48120'
const CLOUDFLARE_SECONDARY = '#FAAD3F'
const PYRITE_PRIMARY = '#43E8D8'
const PYRITE_SECONDARY = '#008080'

const PACKET_DIAMOND = d3.symbol().type(d3.symbolDiamond).size(48)()

// ─── Geo helpers ──────────────────────────────────────────────────────────────

function toFeatures(source: any): any[] {
  if (!source) return []
  if (source.type === 'FeatureCollection')
    return Array.isArray(source.features) ? source.features : []
  if (source.type === 'Feature') return [source]
  if (source.type === 'Topology' && source.objects) {
    return Object.values(source.objects as Record<string, any>).flatMap(
      (obj) => {
        const converted = topojson.feature(source, obj as any) as any
        if (!converted) return []
        return converted.type === 'FeatureCollection'
          ? converted.features
          : converted.type === 'Feature'
            ? [converted]
            : []
      }
    )
  }
  return []
}

function getPointCoordinates(feature: any): Point {
  const coords = feature?.geometry?.coordinates
  return feature?.geometry?.type === 'Point'
    && Array.isArray(coords)
    && coords.length >= 2
    ? (coords as Point)
    : (d3.geoCentroid(feature) as Point)
}

function getFeatureName(feature: any) {
  const city
    = feature?.properties?.city ?? feature?.properties?.City ?? 'Unknown'
  const country
    = feature?.properties?.country ?? feature?.properties?.Country ?? 'Unknown'
  return `${city}, ${country}`
}

function normalizeColo(v?: string | null) {
  return v?.trim().toUpperCase() ?? ''
}
function normalizeRegion(v?: string | null) {
  return v?.trim().toLowerCase() ?? ''
}

// ─── Static geo data (computed once) ─────────────────────────────────────────

const countries = toFeatures(countriesTopology).filter(
  (d: any) => d.properties?.name !== 'Antarctica'
)

const projection = d3.geoNaturalEarth1().fitSize([WIDTH, HEIGHT], {
  type: 'FeatureCollection',
  features: countries
} as any)

const mapPath = d3.geoPath(projection)

/**
 * Build a NodePoint and pre-project its coordinates so the projection
 * function is never called inside the hot render loop.
 */
function makeNode(
  id: string,
  name: string,
  coords: Point,
  extra: Pick<NodePoint, 'colo' | 'region'>
): NodePoint {
  const proj = projection(coords) as [number, number] | null
  return {
    id,
    name,
    coords,
    projected: proj ?? [0, 0],
    ...extra
  }
}

const cloudflareServers: NodePoint[] = toFeatures(cloudflareTopology).map(
  (f: any, i: number) =>
    makeNode(`cf-${i}`, getFeatureName(f), getPointCoordinates(f), {
      colo: normalizeColo(f.properties?.colo ?? f.properties?.IATA)
    })
)

const pyriteServers: NodePoint[] = toFeatures(pyriteCloudTopology).map(
  (f: any, i: number) =>
    makeNode(`py-${i}`, getFeatureName(f), getPointCoordinates(f), {
      region: normalizeRegion(f.properties?.region ?? f.properties?.Region)
    })
)

const cloudflareByColo = new Map(
  cloudflareServers.filter(s => s.colo).map(s => [s.colo as string, s])
)
const pyriteByRegion = new Map(
  pyriteServers.filter(s => s.region).map(s => [s.region as string, s])
)

// ─── Bounded LRU-style trace path cache ──────────────────────────────────────

/**
 * Memoises SVG arc paths between node pairs.
 * Evicts the oldest entry once the cap is reached so memory is bounded.
 */
const traceCache = new Map<
  string,
  { pathD: string, interpolate: (t: number) => Point }
>()

function getOrBuildTrace(source: NodePoint, target: NodePoint) {
  const key = `${source.id}:${target.id}`
  const cached = traceCache.get(key)
  if (cached) return cached

  if (traceCache.size >= TRACE_CACHE_MAX) {
    // Map preserves insertion order — delete the oldest key
    traceCache.delete(traceCache.keys().next().value!)
  }

  const interpolate = d3.geoInterpolate(source.coords, target.coords)
  const coordinates: Point[] = []
  for (let t = 0; t <= 1.00001; t += 0.03) coordinates.push(interpolate(t))
  coordinates[coordinates.length - 1] = target.coords

  const entry = {
    pathD: mapPath({ type: 'LineString', coordinates } as any) ?? '',
    interpolate
  }
  traceCache.set(key, entry)
  return entry
}

// ─── Reactive state ───────────────────────────────────────────────────────────

const svgRef = shallowRef<SVGSVGElement | null>(null)
const rps = shallowRef(5)

// Counters
const totalRequests = shallowRef(0)
const successRequests = shallowRef(0)
const errorRequests = shallowRef(0)
const inflightRequests = shallowRef(0)
const latencyAvgMs = shallowRef(0)

// Latest request list (fixed size, no expensive unshift+slice every tick)
const latestRequests = shallowRef<LiveRequest[]>([])

// Pod registry — use shallowRef; we'll trigger reactivity manually
const podRegistry = shallowRef<Map<string, PodState>>(new Map())

/**
 * `now` is updated every animation frame so template bindings that depend
 * on the current time (pod idle/active state) stay accurate without
 * calling `Date.now()` from inside `:class` expressions.
 */
const now = shallowRef(Date.now())

// ─── Computed ─────────────────────────────────────────────────────────────────

const podsByRegion = computed(() => {
  // Read from the registry snapshot; eviction is done by a separate interval
  const grouped = new Map<string, PodState[]>()
  for (const pod of podRegistry.value.values()) {
    if (!grouped.has(pod.region)) grouped.set(pod.region, [])
    grouped.get(pod.region)!.push(pod)
  }
  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([region, pods]) => ({
      region,
      pods: pods.sort((a, b) => a.hostname.localeCompare(b.hostname))
    }))
})

// ─── Pod helpers ──────────────────────────────────────────────────────────────

function upsertPod(hostname: string, region: string, success: boolean) {
  const registry = podRegistry.value
  const existing = registry.get(hostname)
  if (existing) {
    existing.lastSeenAt = Date.now()
    existing.lastStatus = success ? 'success' : 'error'
    existing.requestCount += 1
  } else {
    registry.set(hostname, {
      hostname,
      region,
      lastSeenAt: Date.now(),
      lastStatus: success ? 'success' : 'error',
      requestCount: 1
    })
  }
  // Trigger computed re-evaluation
  podRegistry.value = new Map(registry)
}

// ─── Live request factory ─────────────────────────────────────────────────────

/** All currently-animated requests. Mutated directly; not reactive. */
const activeRequests: LiveRequest[] = []

function createLiveRequest(
  response: InfoResponse,
  latencyMs: number,
  success: boolean
) {
  const cfColo
    = response.cloudflare?.colo
      ?? response.cloudflare?.ray?.split('-')?.[1]
      ?? null
  const source = cfColo
    ? (cloudflareByColo.get(normalizeColo(cfColo)) ?? null)
    : null
  const target = response.pyrite?.region
    ? (pyriteByRegion.get(normalizeRegion(response.pyrite.region)) ?? null)
    : null

  if (!source || !target) return

  const { pathD, interpolate } = getOrBuildTrace(source, target)

  const request: LiveRequest = {
    id: crypto.randomUUID(),
    source,
    target,
    createdAt: Date.now(),
    latencyMs,
    pathD,
    interpolate,
    hostname: response.pyrite?.hostname ?? 'unknown',
    region: response.pyrite?.region ?? 'unknown',
    success
  }

  // Bounded active list
  activeRequests.push(request)
  if (activeRequests.length > MAX_TRACES) {
    activeRequests.splice(0, activeRequests.length - MAX_TRACES)
  }

  // Prepend to latest list without repeated array allocation
  const latest = latestRequests.value
  latest.unshift(request)
  if (latest.length > MAX_LATEST) latest.length = MAX_LATEST
  latestRequests.value = latest // trigger reactivity

  upsertPod(request.hostname, request.region, success)
}

// ─── HTTP polling ─────────────────────────────────────────────────────────────

let pollingTimer: ReturnType<typeof setTimeout> | undefined
let keepPolling = false

async function pollInfo() {
  totalRequests.value += 1
  inflightRequests.value += 1

  const startedAt = performance.now()
  try {
    const response = await $fetch<InfoResponse>('/info', {
      cache: 'no-store',
      timeout: REQUEST_TIMEOUT_MS
    })

    const latencyMs = performance.now() - startedAt
    successRequests.value += 1
    // Exponential moving average (α = 0.1)
    latencyAvgMs.value
      = latencyAvgMs.value === 0
        ? latencyMs
        : latencyAvgMs.value * 0.9 + latencyMs * 0.1

    createLiveRequest(response, latencyMs, true)
  } catch (err) {
    errorRequests.value += 1
    console.error(err)
  } finally {
    inflightRequests.value = Math.max(0, inflightRequests.value - 1)
  }
}

function restartPolling() {
  stopPolling()
  if (rps.value === 0) return
  keepPolling = true
  const intervalMs = Math.max(15, Math.floor(1_000 / rps.value))
  const tick = () => {
    if (!keepPolling) return
    void pollInfo()
    pollingTimer = setTimeout(tick, intervalMs)
  }
  tick()
}

function resetPolling() {
  rps.value = 5
  restartPolling()
}

function stopPolling() {
  keepPolling = false
  if (pollingTimer) clearTimeout(pollingTimer)
}

// ─── Packet color helper (pure function, no closure) ─────────────────────────

function packetColor(latencyMs: number, success: boolean) {
  if (!success) return '#ef4444'
  if (latencyMs < 120) return '#22c55e'
  if (latencyMs < 300) return '#f59e0b'
  return PYRITE_PRIMARY
}

function traceColor(latencyMs: number, success: boolean) {
  if (!success) return '#ef4444'
  if (latencyMs < 120) return '#22c55e'
  if (latencyMs < 300) return '#f59e0b'
  return '#fb7185'
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let animationFrame = 0
let evictInterval: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  // ── Build static SVG layers ──────────────────────────────────────────────

  const svg = d3.select(svgRef.value)
  svg.selectAll('*').remove()
  svg.attr('viewBox', `0 0 ${WIDTH} ${HEIGHT}`)

  const mapLayer = svg.append('g')
  const traceLayer = svg.append('g')
  const packetLayer = svg.append('g')
  const cloudflareLayer = svg.append('g')
  const pyriteLayer = svg.append('g')

  // Countries
  mapLayer
    .selectAll('path')
    .data(countries)
    .enter()
    .append('path')
    .attr('d', mapPath as any)
    .attr('fill', '#111827')
    .attr('stroke', '#1f2937')
    .attr('stroke-width', 0.75)

  // Cloudflare nodes — use pre-projected coords to skip projection in data join
  const cfNodes = cloudflareLayer
    .selectAll('circle')
    .data(cloudflareServers)
    .enter()
    .append('circle')
    .attr('cx', d => d.projected[0])
    .attr('cy', d => d.projected[1])
    .attr('r', 3)
    .attr('fill', CLOUDFLARE_PRIMARY)
    .attr('stroke', CLOUDFLARE_SECONDARY)
    .attr('stroke-width', 1)
    .attr('opacity', 0.85)
  cfNodes.append('title').text(d => `${d.colo}\n${d.name}`)

  // Pyrite nodes
  const pyNodes = pyriteLayer
    .selectAll('circle')
    .data(pyriteServers)
    .enter()
    .append('circle')
    .attr('cx', d => d.projected[0])
    .attr('cy', d => d.projected[1])
    .attr('r', 6)
    .attr('fill', PYRITE_PRIMARY)
    .attr('stroke', PYRITE_SECONDARY)
    .attr('stroke-width', 1.5)
  pyNodes.append('title').text(d => `${d.region}\n${d.name}`)

  pyriteLayer
    .selectAll('text')
    .data(pyriteServers)
    .enter()
    .append('text')
    .attr('x', d => d.projected[0] + 10)
    .attr('y', d => d.projected[1] + 4)
    .text(d => d.region ?? d.name)
    .attr('fill', '#ffffff')
    .attr('font-size', 11)
    .attr('paint-order', 'stroke')
    .attr('stroke', '#020617')
    .attr('stroke-width', 3)

  // ── Animation loop ───────────────────────────────────────────────────────

  const render = () => {
    const ts = Date.now()
    now.value = ts // drives template bindings that depend on current time

    const active = activeRequests.filter(
      d => ts - d.createdAt < TRACE_TTL_MS
    )

    // Trace arcs
    traceLayer
      .selectAll<SVGPathElement, LiveRequest>('path')
      .data(active, d => d.id)
      .join(
        enter =>
          enter
            .append('path')
            .attr('fill', 'none')
            .attr('stroke-width', 2)
            .attr('stroke-linecap', 'round'),
        update => update,
        exit => exit.remove()
      )
      .attr('d', d => d.pathD)
      .attr('stroke', d => traceColor(d.latencyMs, d.success))
      .attr('opacity', d =>
        Math.max(0, 1 - (ts - d.createdAt) / TRACE_TTL_MS)
      )

    // Animated diamond packets — use pre-projected coordinates inside transform
    packetLayer
      .selectAll<SVGPathElement, LiveRequest>('path')
      .data(active, d => d.id)
      .join(
        enter =>
          enter.append('path').attr('d', PACKET_DIAMOND).attr('opacity', 0.95),
        update => update,
        exit => exit.remove()
      )
      .attr('fill', d => packetColor(d.latencyMs, d.success))
      .attr('filter', 'drop-shadow(0 0 2px rgba(255,255,255,0.25))')
      .attr('transform', (d) => {
        const progress = Math.min((ts - d.createdAt) / TRACE_TTL_MS, 1)
        const geoPoint = d.interpolate(progress)
        const proj = projection(geoPoint)
        return proj ? `translate(${proj[0]},${proj[1]}) rotate(45)` : ''
      })

    animationFrame = requestAnimationFrame(render)
  }

  render()

  // ── Pod eviction (moved out of computed) ─────────────────────────────────

  evictInterval = setInterval(() => {
    const ts = Date.now()
    const registry = podRegistry.value
    let changed = false
    for (const [hostname, pod] of registry.entries()) {
      if (ts - pod.lastSeenAt > POD_DELETE_MS) {
        registry.delete(hostname)
        changed = true
      }
    }
    if (changed) podRegistry.value = new Map(registry)
  }, POD_EVICT_INTERVAL_MS)

  restartPolling()
})

onBeforeUnmount(() => {
  stopPolling()
  cancelAnimationFrame(animationFrame)
  if (evictInterval) clearInterval(evictInterval)
})
</script>

<template>
  <UContainer class="min-h-screen max-w-[1920px] py-4 sm:py-6">
    <div class="space-y-4">
      <!-- ── Stat cards ── -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <UCard class="border-white/10 bg-black xl:col-span-1">
          <template #header>
            <div class="text-xs uppercase tracking-wide text-neutral-400">
              Total Requests
            </div>
          </template>
          <div class="text-3xl font-bold text-white">
            {{ totalRequests }}
          </div>
          <div class="mt-2 text-sm text-slate-400">
            Avg latency: {{ latencyAvgMs.toFixed(0) }} ms
          </div>
        </UCard>

        <UCard class="border-white/10 bg-black xl:col-span-1">
          <template #header>
            <div class="text-xs uppercase tracking-wide text-neutral-400">
              Inflight
            </div>
          </template>
          <div class="text-3xl font-bold text-warning">
            {{ inflightRequests }}
          </div>
        </UCard>

        <UCard class="border-white/10 bg-black xl:col-span-1">
          <template #header>
            <div class="text-xs uppercase tracking-wide text-neutral-400">
              Success
            </div>
          </template>
          <div class="text-3xl font-bold text-success">
            {{ successRequests }}
          </div>
        </UCard>

        <UCard class="border-white/10 bg-black xl:col-span-1">
          <template #header>
            <div class="text-xs uppercase tracking-wide text-neutral-400">
              Errors
            </div>
          </template>
          <div class="text-3xl font-bold text-error">
            {{ errorRequests }}
          </div>
        </UCard>

        <UCard class="border-white/10 bg-black sm:col-span-2 xl:col-span-2">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div class="text-sm font-medium text-white">
                Requests Per Second
              </div>
              <div class="text-xs text-neutral-400">
                Adjust the slider to change the rate
              </div>
            </div>
            <UBadge
              color="neutral"
              variant="soft"
              size="lg"
            >
              {{ rps }} RPS
            </UBadge>
          </div>
          <div class="mt-5 space-y-4">
            <USlider
              v-model="rps"
              :min="0"
              :max="250"
              :step="5"
              @update:model-value="restartPolling"
            />
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="solid"
                size="md"
                @click="resetPolling"
              >
                Reset
              </UButton>
              <UButton
                color="error"
                variant="solid"
                size="md"
                @click="stopPolling"
              >
                Stop
              </UButton>
            </div>
          </div>
        </UCard>
      </div>

      <!-- ── Pod registry ── -->
      <UCard class="border-white/10 bg-black">
        <template #header>
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-white">
                Replicas
              </div>
              <div class="text-xs text-neutral-400">
                Live pod visualization
              </div>
              <div class="mt-2 flex flex-wrap gap-3 text-[11px] text-neutral-400">
                <div class="flex items-center gap-1">
                  <span class="h-2 w-2 rounded-full bg-success" /> Healthy
                </div>
                <div class="flex items-center gap-1">
                  <span class="h-2 w-2 rounded-full bg-error" /> Error
                </div>
                <div class="flex items-center gap-1">
                  <span class="h-2 w-2 rounded-full bg-gray-500" /> Idle
                </div>
              </div>
            </div>
            <UBadge
              color="neutral"
              variant="soft"
            >
              {{ podsByRegion.length }} Regions
            </UBadge>
          </div>
        </template>

        <div class="flex flex-wrap gap-4 overflow-x-auto pb-2">
          <div
            v-for="group in podsByRegion"
            :key="group.region"
            class="min-w-[260px] shrink-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4"
          >
            <div class="mb-4 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="h-2 w-2 rounded-full bg-violet-400" />
                <div class="text-sm font-medium text-white">
                  {{ group.region }}
                </div>
              </div>
              <UBadge
                size="sm"
                color="neutral"
                variant="soft"
              >
                {{ group.pods.length }}
              </UBadge>
            </div>

            <TransitionGroup
              name="pod"
              tag="div"
              class="flex flex-wrap gap-2"
            >
              <div
                v-for="pod in group.pods"
                :key="pod.hostname"
                class="group relative"
              >
                <UTooltip :text="`${pod.hostname} · ${pod.requestCount} req`">
                  <div
                    :class="[
                      'flex aspect-square h-14 flex-col items-center justify-center rounded-xl border text-[10px] font-medium transition-all duration-500 ease-out animate-in fade-in zoom-in-50',
                      now - pod.lastSeenAt > POD_IDLE_MS
                        ? 'border-white/10 bg-gray-500/20 text-gray-500 opacity-40'
                        : pod.lastStatus === 'success'
                          ? 'border-success/30 bg-success/20 text-success shadow-lg shadow-success/10'
                          : 'border-error/30 bg-error/20 text-error shadow-lg shadow-error/10'
                    ]"
                  >
                    <span>{{ pod.hostname.split('-').slice(-1)[0] }}</span>
                    <!-- Use reactive `now` instead of calling Date.now() in template -->
                    <span class="mt-1 text-[9px] opacity-70">
                      {{ Math.floor((now - pod.lastSeenAt) / 1000) }}s
                    </span>
                  </div>
                </UTooltip>
              </div>
            </TransitionGroup>
          </div>
        </div>
      </UCard>

      <!-- ── World map ── -->
      <UCard class="overflow-hidden border-white/10 bg-black">
        <template #header>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div class="text-sm font-semibold text-white">
                Global Request Flow
              </div>
              <div class="text-xs text-neutral-400">
                Cloudflare → Pyrite Cloud
              </div>
            </div>
            <div class="flex items-center gap-2 text-xs text-neutral-400">
              <div class="flex items-center gap-1">
                <span class="h-2 w-2 rounded-full bg-[#F48120]" /> Cloudflare
              </div>
              <div class="flex items-center gap-1">
                <span class="h-2 w-2 rounded-full bg-[#43E8D8]" /> Pyrite Cloud
              </div>
            </div>
          </div>
        </template>

        <div class="relative h-[55vh] min-h-[420px] w-full sm:h-[65vh] xl:h-[72vh]">
          <svg
            ref="svgRef"
            class="h-full w-full bg-black"
          />
        </div>
      </UCard>
    </div>
  </UContainer>
</template>

<style scoped>
.pod-enter-active,
.pod-leave-active {
  transition: all 0.4s ease;
}
.pod-enter-from,
.pod-leave-to {
  opacity: 0;
  transform: scale(0.8) translateY(8px);
}
</style>
