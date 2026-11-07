import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { mountFrontend, resolveFrontendDist } from './frontendStatic'

const html = '<!doctype html><html><head><title>Opal Line Billing</title></head><body><div id="root"></div></body></html>\n'

async function serve(dist: string): Promise<{ server: Server; port: number }> {
  const app = express()
  mountFrontend(app, dist)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

/**
 * `node:http` rather than the global `fetch`: on Windows, two fetches against
 * a just-closed listener leave undici async handles that `--test-force-exit`
 * closes twice, aborting the whole test process (`UV_HANDLE_CLOSING` in uv
 * async.c) even though every assertion passed.
 */
function body(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
  })
}

test('a deep link serves index.html for a relative and an absolute FRONTEND_DIST', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opal-frontend-'))
  const backendCwd = join(root, 'backend')
  const dist = join(root, 'frontend', 'dist')
  await mkdir(dist, { recursive: true })
  await mkdir(backendCwd, { recursive: true })
  await writeFile(join(dist, 'index.html'), html, 'utf8')
  const onDisk = await readFile(join(dist, 'index.html'), 'utf8')

  try {
    for (const candidate of ['../frontend/dist', dist]) {
      const resolved = resolveFrontendDist([candidate], backendCwd)
      assert.equal(resolved, dist)
      const { server, port } = await serve(resolved)
      try {
        const rootPage = await body(port, '/')
        const deep = await body(port, '/inventory/products')
        assert.equal(rootPage.status, 200)
        assert.equal(deep.status, 200)
        assert.equal(deep.text, onDisk)
        assert.equal(deep.text, rootPage.text)
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
