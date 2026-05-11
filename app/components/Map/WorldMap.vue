<script setup lang="ts">
// biome-ignore-all lint: visualization file
import * as d3 from 'd3'
import * as topojson from 'topojson-client'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import cloudflareTopology from '@/assets/cloudflare.json'
import countriesTopology from '@/assets/countries-110m.json'
import pyriteCloudTopology from '@/assets/pyrite-cloud.json'

type Point = [number, number]

type NodePoint = {
  id: string
  name: string
  colo?: string
  region?: string
  coords: Point
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
  pyrite?: {
    region?: string
    hostname?: string
  }
  cloudflare?: {
    ray?: string | null
    colo?: string | null
  }
}

const width = 1400
const height = 720

const TRACE_TTL_MS = 6000
const MAX_TRACES = 300

const REQUEST_TIMEOUT_MS = 1000

const POD_IDLE_MS = 10_000
const POD_DELETE_MS = 60_000

const CLOUDFLARE_PRIMARY = '#F48120'

const CLOUDFLARE_SECONDARY = '#FAAD3F'

const PYRITE_PRIMARY = '#43E8D8'

const PYRITE_SECONDARY = '#008080'

const PACKET_DIAMOND = d3.symbol().type(d3.symbolDiamond).size(48)()

const svgRef = ref<SVGSVGElement | null>(null)

const rps = ref(2)

const totalRequests = ref(0)
const successRequests = ref(0)
const errorRequests = ref(0)
const inflightRequests = ref(0)
const latencyAvgMs = ref(0)

const latestRequests = ref<LiveRequest[]>([])

const errorHistory = ref<number[]>([])

const podRegistry = ref<Map<string, PodState>>(new Map())

const activeRequests: LiveRequest[] = []

const traceCache = new Map<
  string,
  {
    pathD: string
    interpolate: (t: number) => Point
  }
>()

let animationFrame = 0

let pollingTimer: ReturnType<typeof setTimeout> | undefined

let keepPolling = true

function normalizeColo(value?: string | null) {
  return value?.trim().toUpperCase() ?? ''
}

function normalizeRegion(value?: string | null) {
  return value?.trim().toLowerCase() ?? ''
}

function toFeatures(source: any): any[] {
  if (!source) {
    return []
  }

  if (source.type === 'FeatureCollection') {
    return Array.isArray(source.features) ? source.features : []
  }

  if (source.type === 'Feature') {
    return [source]
  }

  if (source.type === 'Topology' && source.objects) {
    const features: any[] = []

    const objects = Object.values(source.objects as Record<string, any>)

    for (const object of objects) {
      const converted = topojson.feature(source, object as any) as any

      if (!converted) {
        continue
      }

      if (converted.type === 'FeatureCollection') {
        features.push(...converted.features)
      } else if (converted.type === 'Feature') {
        features.push(converted)
      }
    }

    return features
  }

  return []
}

function getPointCoordinates(feature: any): Point {
  const coords = feature?.geometry?.coordinates

  if (
    feature?.geometry?.type === 'Point'
    && Array.isArray(coords)
    && coords.length >= 2
  ) {
    return coords as Point
  }

  return d3.geoCentroid(feature) as Point
}

function getFeatureName(feature: any) {
  const city
    = feature?.properties?.city ?? feature?.properties?.City ?? 'Unknown'

  const country
    = feature?.properties?.country ?? feature?.properties?.Country ?? 'Unknown'

  return `${city}, ${country}`
}

const countries = toFeatures(countriesTopology).filter(
  (d: any) => d.properties?.name !== 'Antarctica'
)

const cloudflareServers: NodePoint[] = toFeatures(cloudflareTopology).map(
  (f: any, index: number) => ({
    id: `cf-${index}`,

    colo: normalizeColo(f.properties?.colo ?? f.properties?.IATA),

    name: getFeatureName(f),

    coords: getPointCoordinates(f)
  })
)

const pyriteServers: NodePoint[] = toFeatures(pyriteCloudTopology).map(
  (f: any, index: number) => ({
    id: `py-${index}`,

    region: normalizeRegion(f.properties?.region ?? f.properties?.Region),

    name: getFeatureName(f),

    coords: getPointCoordinates(f)
  })
)

const cloudflareByColo = new Map(
  cloudflareServers
    .filter(server => server.colo)
    .map(server => [server.colo as string, server])
)

const pyriteByRegion = new Map(
  pyriteServers
    .filter(server => server.region)
    .map(server => [server.region as string, server])
)

const podsByRegion = computed(() => {
  const now = Date.now()

  for (const [hostname, pod] of podRegistry.value.entries()) {
    if (now - pod.lastSeenAt > POD_DELETE_MS) {
      podRegistry.value.delete(hostname)
    }
  }

  const grouped = new Map<string, PodState[]>()

  for (const pod of podRegistry.value.values()) {
    if (!grouped.has(pod.region)) {
      grouped.set(pod.region, [])
    }

    grouped.get(pod.region)?.push(pod)
  }

  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([region, pods]) => ({
      region,

      pods: pods.sort((a, b) => a.hostname.localeCompare(b.hostname))
    }))
})

const projection = d3.geoNaturalEarth1().fitSize([width, height], {
  type: 'FeatureCollection',
  features: countries
} as any)

const mapPath = d3.geoPath(projection)

function getTraceCacheKey(source: NodePoint, target: NodePoint) {
  return `${source.id}:${target.id}`
}

function buildTracePath(source: Point, target: Point) {
  const interpolate = d3.geoInterpolate(source, target)

  const coordinates: Point[] = []

  for (let t = 0; t <= 1.00001; t += 0.03) {
    coordinates.push(interpolate(t))
  }

  coordinates[coordinates.length - 1] = target

  return {
    pathD:
			mapPath({
			  type: 'LineString',
			  coordinates
			} as any) ?? '',

    interpolate
  }
}

function findCloudflare(colo?: string | null) {
  const normalized = normalizeColo(colo)

  return normalized ? (cloudflareByColo.get(normalized) ?? null) : null
}

function findPyrite(region?: string | null) {
  const normalized = normalizeRegion(region)

  return normalized ? (pyriteByRegion.get(normalized) ?? null) : null
}

function packetColor(latencyMs: number, success: boolean) {
  if (!success) {
    return '#ef4444'
  }

  if (latencyMs < 120) {
    return CLOUDFLARE_PRIMARY
  }

  if (latencyMs < 300) {
    return '#f59e0b'
  }

  return PYRITE_PRIMARY
}

function createLiveRequest(
  response: InfoResponse,
  latencyMs: number,
  success: boolean
) {
  const source = findCloudflare(
    response.cloudflare?.colo
    ?? response.cloudflare?.ray?.split('-')?.[1]
    ?? null
  )

  const target = findPyrite(response.pyrite?.region)

  if (!source || !target) {
    return
  }

  const cacheKey = getTraceCacheKey(source, target)

  let cached = traceCache.get(cacheKey)

  if (!cached) {
    cached = buildTracePath(source.coords, target.coords)

    traceCache.set(cacheKey, cached)
  }

  const request: LiveRequest = {
    id: crypto.randomUUID(),

    source,
    target,

    createdAt: Date.now(),

    latencyMs,

    pathD: cached.pathD,

    interpolate: cached.interpolate,

    hostname: response.pyrite?.hostname ?? 'unknown',

    region: response.pyrite?.region ?? 'unknown',

    success
  }

  activeRequests.push(request)

  latestRequests.value.unshift(request)

  latestRequests.value = latestRequests.value.slice(0, 20)

  const existingPod = podRegistry.value.get(request.hostname)

  if (existingPod) {
    existingPod.lastSeenAt = Date.now()

    existingPod.lastStatus = success ? 'success' : 'error'

    existingPod.requestCount += 1
  } else {
    podRegistry.value.set(request.hostname, {
      hostname: request.hostname,

      region: request.region,

      lastSeenAt: Date.now(),

      lastStatus: success ? 'success' : 'error',

      requestCount: 1
    })
  }

  if (activeRequests.length > MAX_TRACES) {
    activeRequests.splice(0, activeRequests.length - MAX_TRACES)
  }
}

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

    latencyAvgMs.value
      = latencyAvgMs.value === 0
        ? latencyMs
        : latencyAvgMs.value * 0.9 + latencyMs * 0.1

    createLiveRequest(response, latencyMs, true)
  } catch (error) {
    errorRequests.value += 1

    errorHistory.value.push(Date.now())

    errorHistory.value = errorHistory.value.slice(-40)

    console.error(error)
  } finally {
    inflightRequests.value = Math.max(0, inflightRequests.value - 1)
  }
}

function restartPolling() {
  if (pollingTimer) {
    clearTimeout(pollingTimer)
  }

  keepPolling = true

  const intervalMs = Math.max(15, Math.floor(1000 / rps.value))

  const tick = () => {
    if (!keepPolling) {
      return
    }

    void pollInfo()

    pollingTimer = setTimeout(tick, intervalMs)
  }

  tick()
}

function stopPolling() {
  keepPolling = false

  if (pollingTimer) {
    clearTimeout(pollingTimer)
  }
}

onMounted(() => {
  const svg = d3.select(svgRef.value)

  svg.selectAll('*').remove()

  svg.attr('viewBox', `0 0 ${width} ${height}`)

  const defs = svg.append('defs')

  const gradient = defs.append('linearGradient').attr('id', 'trace-gradient')

  gradient
    .append('stop')
    .attr('offset', '0%')
    .attr('stop-color', CLOUDFLARE_PRIMARY)

  gradient
    .append('stop')
    .attr('offset', '100%')
    .attr('stop-color', PYRITE_PRIMARY)

  const mapLayer = svg.append('g')

  const traceLayer = svg.append('g')

  const packetLayer = svg.append('g')

  const cloudflareLayer = svg.append('g')

  const pyriteLayer = svg.append('g')

  mapLayer
    .selectAll('path')
    .data(countries)
    .enter()
    .append('path')
    .attr('d', mapPath as any)
    .attr('fill', '#111827')
    .attr('stroke', '#1f2937')
    .attr('stroke-width', 0.75)

  const cfNodes = cloudflareLayer
    .selectAll('circle')
    .data(cloudflareServers)
    .enter()
    .append('circle')
    .attr('cx', d => projection(d.coords)?.[0] ?? 0)
    .attr('cy', d => projection(d.coords)?.[1] ?? 0)
    .attr('r', 3)
    .attr('fill', CLOUDFLARE_PRIMARY)
    .attr('stroke', CLOUDFLARE_SECONDARY)
    .attr('stroke-width', 1)
    .attr('opacity', 0.85)

  cfNodes.append('title').text(d => `${d.colo}\n${d.name}`)

  const pyNodes = pyriteLayer
    .selectAll('circle')
    .data(pyriteServers)
    .enter()
    .append('circle')
    .attr('cx', d => projection(d.coords)?.[0] ?? 0)
    .attr('cy', d => projection(d.coords)?.[1] ?? 0)
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
    .attr('x', d => (projection(d.coords)?.[0] ?? 0) + 10)
    .attr('y', d => (projection(d.coords)?.[1] ?? 0) + 4)
    .text(d => d.region ?? d.name)
    .attr('fill', '#ffffff')
    .attr('font-size', 11)
    .attr('paint-order', 'stroke')
    .attr('stroke', '#020617')
    .attr('stroke-width', 3)

  const render = () => {
    const now = Date.now()

    const active = activeRequests.filter(
      d => now - d.createdAt < TRACE_TTL_MS
    )

    traceLayer
      .selectAll<SVGPathElement, LiveRequest>('path')
      .data(active, (d: any) => d.id)
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
      .attr('stroke', (d) => {
        if (!d.success) {
          return '#ef4444'
        }

        if (d.latencyMs < 120) {
          return 'url(#trace-gradient)'
        }

        if (d.latencyMs < 300) {
          return '#f59e0b'
        }

        return '#fb7185'
      })
      .attr('opacity', d =>
        Math.max(0, 1 - (now - d.createdAt) / TRACE_TTL_MS)
      )

    packetLayer
      .selectAll<SVGPathElement, LiveRequest>('path')
      .data(active, (d: any) => d.id)
      .join(
        enter =>
          enter.append('path').attr('d', PACKET_DIAMOND).attr('opacity', 0.95),

        update => update,

        exit => exit.remove()
      )
      .attr('fill', d => packetColor(d.latencyMs, d.success))
      .attr('filter', 'drop-shadow(0 0 2px rgba(255,255,255,0.25))')
      .attr('transform', (d) => {
        const progress = Math.min((now - d.createdAt) / TRACE_TTL_MS, 1)

        const point = d.interpolate(progress)

        const projected = projection(point)

        return projected
          ? `translate(${projected[0]}, ${projected[1]}) rotate(45)`
          : ''
      })

    animationFrame = requestAnimationFrame(render)
  }

  render()

  restartPolling()
})

onBeforeUnmount(() => {
  stopPolling()

  cancelAnimationFrame(animationFrame)
})
</script>

<template>
  <UContainer
    class="min-h-screen max-w-[1920px] py-4 sm:py-6"
  >
    <div class="space-y-4">
      <div
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6"
      >
        <UCard
          class="border-white/10 bg-black xl:col-span-1"
        >
          <template #header>
            <div
              class="text-xs uppercase tracking-wide text-gray-400"
            >
              Total Requests
            </div>
          </template>

          <div
            class="text-3xl font-bold text-white"
          >
            {{ totalRequests }}
          </div>

          <div
            class="mt-2 text-sm text-slate-400"
          >
            Avg latency:
            {{
              latencyAvgMs.toFixed(0)
            }}
            ms
          </div>
        </UCard>

        <UCard
          class="border-white/10 bg-black xl:col-span-1"
        >
          <template #header>
            <div
              class="text-xs uppercase tracking-wide text-gray-400"
            >
              Inflight
            </div>
          </template>

          <div
            class="text-3xl font-bold text-cyan-300"
          >
            {{
              inflightRequests
            }}
          </div>
        </UCard>

        <UCard
          class="border-white/10 bg-black xl:col-span-1"
        >
          <template #header>
            <div
              class="text-xs uppercase tracking-wide text-gray-400"
            >
              Success
            </div>
          </template>

          <div
            class="text-3xl font-bold text-emerald-400"
          >
            {{
              successRequests
            }}
          </div>
        </UCard>

        <UCard
          class="border-white/10 bg-black xl:col-span-1"
        >
          <template #header>
            <div
              class="flex items-center justify-between"
            >
              <div
                class="text-xs uppercase tracking-wide text-gray-400"
              >
                Errors
              </div>
            </div>
          </template>

          <div
            class="text-3xl font-bold text-red-400"
          >
            {{
              errorRequests
            }}
          </div>
        </UCard>

        <UCard
          class="border-white/10 bg-black sm:col-span-2 xl:col-span-2"
        >
          <div
            class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div
                class="text-sm font-medium text-white"
              >
                Requests Per
                Second
              </div>

              <div
                class="text-xs text-gray-400"
              >
                Evenly
                distributed
                polling
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

          <div class="mt-5">
            <USlider
              v-model="rps"
              :min="1"
              :max="100"
              @update:model-value="
                restartPolling
              "
            />
          </div>
        </UCard>
      </div>

      <UCard
        class="border-white/10 bg-black"
      >
        <template #header>
          <div
            class="flex items-start justify-between gap-4"
          >
            <div>
              <div
                class="text-sm font-semibold text-white"
              >
                Replicas
              </div>

              <div
                class="text-xs text-gray-400"
              >
                Live pod visualization
              </div>

              <div
                class="mt-2 flex flex-wrap gap-3 text-[11px] text-gray-400"
              >
                <div
                  class="flex items-center gap-1"
                >
                  <span
                    class="h-2 w-2 rounded-full bg-[#43E8D8]"
                  />
                  Healthy
                </div>

                <div
                  class="flex items-center gap-1"
                >
                  <span
                    class="h-2 w-2 rounded-full bg-[#F48120]"
                  />
                  Error
                </div>

                <div
                  class="flex items-center gap-1"
                >
                  <span
                    class="h-2 w-2 rounded-full bg-gray-500"
                  />
                  Idle
                </div>
              </div>
            </div>

            <UBadge
              color="neutral"
              variant="soft"
            >
              {{
                podsByRegion.length
              }}
              Regions
            </UBadge>
          </div>
        </template>

        <div
          class="flex flex-wrap gap-4 overflow-x-auto pb-2"
        >
          <div
            v-for="group in podsByRegion"
            :key="group.region"
            class="min-w-[260px] shrink-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4"
          >
            <div
              class="mb-4 flex items-center justify-between"
            >
              <div
                class="flex items-center gap-2"
              >
                <div
                  class="h-2 w-2 rounded-full bg-violet-400"
                />

                <div
                  class="text-sm font-medium text-white"
                >
                  {{
                    group.region
                  }}
                </div>
              </div>

              <UBadge
                size="sm"
                color="neutral"
                variant="soft"
              >
                {{
                  group.pods.length
                }}
              </UBadge>
            </div>

            <TransitionGroup
              name="pod"
              tag="div"
              class="flex flex-wrap gap-2"
            >
              <div
                v-for="pod in group.pods"
                :key="
                  pod.hostname
                "
                class="group relative"
              >
                <UTooltip
                  :text="`${pod.hostname} · ${pod.requestCount} req`"
                >
                  <div
                    :class="[
                      'flex aspect-square h-14 flex-col items-center justify-center rounded-xl border text-[10px] font-medium transition-all duration-500 ease-out animate-in fade-in zoom-in-50',
                      Date.now() - pod.lastSeenAt > POD_IDLE_MS
                        ? 'border-white/10 bg-gray-500/20 text-gray-500 opacity-40'
                        : pod.lastStatus === 'success'
                          ? 'border-[#43E8D8]/30 bg-[#43E8D8]/20 text-[#43E8D8] shadow-lg shadow-[#43E8D8]/10'
                          : 'border-[#F48120]/30 bg-[#F48120]/20 text-[#F48120] shadow-lg shadow-[#F48120]/10'
                    ]"
                  >
                    <span>
                      {{
                        pod.hostname
                          .split(
                            '-'
                          )
                          .slice(
                            -1
                          )[0]
                      }}
                    </span>

                    <span
                      class="mt-1 text-[9px] opacity-70"
                    >
                      {{
                        Math.floor(
                          (Date.now()
                            - pod.lastSeenAt)
                            / 1000
                        )
                      }}s
                    </span>
                  </div>
                </UTooltip>
              </div>
            </TransitionGroup>
          </div>
        </div>
      </UCard>

      <UCard
        class="overflow-hidden border-white/10 bg-black"
      >
        <template #header>
          <div
            class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div
                class="text-sm font-semibold text-white"
              >
                Global Request
                Flow
              </div>

              <div
                class="text-xs text-gray-400"
              >
                Cloudflare →
                Pyrite Cloud
              </div>
            </div>

            <div
              class="flex items-center gap-2 text-xs text-gray-400"
            >
              <div
                class="flex items-center gap-1"
              >
                <span
                  class="h-2 w-2 rounded-full bg-[#F48120]"
                />
                Cloudflare
              </div>

              <div
                class="flex items-center gap-1"
              >
                <span
                  class="h-2 w-2 rounded-full bg-[#43E8D8]"
                />
                Pyrite
              </div>
            </div>
          </div>
        </template>

        <div
          class="relative h-[55vh] min-h-[420px] w-full sm:h-[65vh] xl:h-[72vh]"
        >
          <svg
            ref="svgRef"
            class="h-full w-full bg-black"
          />

          <div
            class="pointer-events-none absolute left-3 top-3 rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-xs text-white backdrop-blur"
          >
            <div
              class="font-medium"
            >
              Live Request
              Traces
            </div>

            <div
              class="mt-1 text-gray-400"
            >
              {{
                activeRequests.length
              }}
              active traces
            </div>
          </div>
        </div>
      </UCard>
    </div>
  </UContainer>
</template>

<style scoped>
.pod-enter-active,
.pod-leave-active {
  transition:
    all 0.4s ease;
}

.pod-enter-from,
.pod-leave-to {
  opacity: 0;
  transform:
    scale(0.8)
    translateY(8px);
}
</style>
