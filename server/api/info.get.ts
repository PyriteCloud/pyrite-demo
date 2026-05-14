import { defineEventHandler, getRequestHeader, setHeader } from 'h3'

const REGIONS = ['us-east-1', 'eu-central-1'] as const

const PYRITE_REGION = process.env.PYRITE_REGION ?? null
const PYRITE_REPLICA_NAME = process.env.PYRITE_REPLICA_NAME ?? null

const isProd = process.env.NODE_ENV === 'production'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Connection', 'close')

  const cfRay = getRequestHeader(event, 'cf-ray') ?? '-BOM'

  const dashIdx = cfRay.lastIndexOf('-')
  const cfColo = dashIdx !== -1 ? cfRay.slice(dashIdx + 1) : ''

  const region = isProd
    ? PYRITE_REGION
    : REGIONS[Math.floor(Math.random() * REGIONS.length)]
  const hostname = isProd
    ? PYRITE_REPLICA_NAME
    : `${region}-${Math.floor(Math.random() * 5)}`

  await new Promise(r => setTimeout(r, 100))

  return {
    timestamp: Date.now(),
    pyrite: {
      region,
      hostname
    },
    cloudflare: {
      ray: cfRay,
      colo: cfColo
    }
  }
})
