import { defineEventHandler, getRequestHeader, setHeader } from 'h3'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Connection', 'close')

  const cfRay = getRequestHeader(event, 'cf-ray') ?? ''
  const cfColo = cfRay?.split('-')[1] ?? ''

  // const regions = ["us-east-1", "eu-central-1", "ap-southeast-1"];
  // const fallbackRegion = regions[Math.floor(Math.random() * regions.length)];

  return {
    timestamp: Date.now(),
    pyrite: {
      region: process.env.PYRITE_REGION,
      // ?? fallbackRegion,
      hostname: process.env.PYRITE_REPLICA_NAME
      // ?? `${fallbackRegion}-${Math.floor(Math.random() * 5)}`,
    },

    cloudflare: {
      ray: cfRay,
      colo: cfColo
    }
  }
})
