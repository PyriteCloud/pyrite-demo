########## Base image
FROM node:lts AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Enable corepack and pnpm
RUN corepack enable

WORKDIR /app

########## Dependencies stage
FROM base AS deps

# Copy dependency files first for better caching
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

########## Builder stage
FROM base AS builder

ENV NODE_ENV=production
ENV CI=true
ENV NODE_OPTIONS="--max-old-space-size=4096"

WORKDIR /app

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy project files
COPY . .

# Build Nuxt app
RUN pnpm build

########## Runner stage
FROM node:lts-slim AS runner

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Copy Nuxt output
COPY --from=builder /app/.output ./.output

EXPOSE 3000

# Start Nuxt server
CMD ["node", ".output/server/index.mjs"]