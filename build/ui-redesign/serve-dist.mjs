// Audit-only: serve frontend/dist and proxy /api + /uploads to the local backend
// so the production bundle can be measured without Vite or StrictMode.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const DIST = path.resolve('frontend/dist')
const API = process.env.AUDIT_API ?? 'http://127.0.0.1:47191'
const PORT = Number(process.env.AUDIT_PORT ?? 47210)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')

  if (isApi) {
    try {
      const headers = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (['host', 'connection', 'accept-encoding'].includes(k)) continue
        if (v != null) headers[k] = Array.isArray(v) ? v.join(', ') : v
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method ?? 'GET')
      const upstream = await fetch(`${API}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? await readBody(req) : undefined,
        redirect: 'manual',
      })
      const out = {}
      for (const [k, v] of upstream.headers) {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) continue
        out[k] = v
      }
      const cookies = upstream.headers.getSetCookie?.() ?? []
      if (cookies.length) out['set-cookie'] = cookies
      res.writeHead(upstream.status, out)
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`proxy error: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }

  let file = path.join(DIST, decodeURIComponent(url.pathname))
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html')
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  fs.createReadStream(file).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`audit dist server on http://127.0.0.1:${PORT} -> ${API}`)
})
