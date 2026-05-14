<script setup>
useHead({
  meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  link: [{ rel: 'icon', href: '/favicon.ico' }],
  htmlAttrs: {
    lang: 'en'
  }
})

const title = 'Pyrite Cloud Demo'
const description = 'Pyrite Cloud Global Load Balancing and Auto-Scaling Demo'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: './logo.webp'
})
</script>

<template>
  <UApp>
    <UHeader
      title="Pyrite Cloud - Global Load Balancing & Auto-Scaling Demo"
      :ui="{
        container: 'max-w-full'
      }"
    >
      <template #right>
        <UColorModeButton />
      </template>
    </UHeader>

    <UMain>
      <NuxtPage />
    </UMain>
  </UApp>
</template>
