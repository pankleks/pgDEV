export function isAppUrl(value, development = false) {
  try {
    const url = new URL(value)
    return development
      ? url.origin === 'http://127.0.0.1:5173'
      : url.protocol === 'pgdev:' && url.hostname === 'app'
  } catch { return false }
}

/** Renderer requests can reach only existing API operations, never arbitrary URLs. */
export function validateRequest(method, path, body) {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\\') || path.includes('#')) throw new Error('Invalid API path')
  const url = new URL(path, 'http://backend')
  if (url.origin !== 'http://backend' || !path.startsWith('/api/')) throw new Error('Invalid API path')
  const routes = {
    GET: [/^\/api\/version$/, /^\/api\/ai\/config$/, /^\/api\/connections\/[\w-]+\/(schema|ddl)$/, /^\/api\/connections\/[\w-]+\/tableedit\/\d+$/],
    POST: [/^\/api\/connections$/, /^\/api\/connections\/[\w-]+\/(query|query\/more|query\/close|cancel|row-update)$/, /^\/api\/connections\/[\w-]+\/tableedit\/\d+$/, /^\/api\/ai\/bridge\/result$/],
    DELETE: [/^\/api\/connections\/[\w-]+$/],
    PUT: [/^\/api\/ai\/limits$/],
  }
  if (!routes[method]?.some((route) => route.test(url.pathname))) throw new Error('API operation is not allowed')
  if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > 4 * 1024 * 1024) throw new Error('Request is too large')
  return url.pathname + url.search
}
