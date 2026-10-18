const CACHE = 'memo-flick-v2'
const isHashedAsset = pathname => /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(pathname)

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    const page = await fetch('/')
    if (page.ok) {
      await cache.put('/', page.clone())
      const html = await page.text()
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
        .map(match => match[1])
        .filter(path => isHashedAsset(new URL(path, self.location.origin).pathname))
      await Promise.all(assets.map(path => cache.add(path)))
    }
    await cache.addAll(['/manifest.webmanifest', '/icon.svg'])
    await self.skipWaiting()
  })())
})
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key.startsWith('memo-flick-') && key !== CACHE).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' })
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
          const cache = await caches.open(CACHE)
          await cache.put('/', response.clone())
        }
        return response
      } catch (error) {
        const cached = await caches.match('/')
        if (cached) return cached
        throw error
      }
    })())
    return
  }

  if (isHashedAsset(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) await cache.put(request, response.clone())
      return response
    })())
  }
})
