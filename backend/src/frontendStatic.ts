import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import express, { type Express } from 'express'

/** Turn a FRONTEND_DIST value into an absolute directory. Relative values are
 * resolved from `cwd` (the backend package directory when npm runs the server).
 * sendFile rejects relative paths, so a value like ../frontend/dist must not
 * be passed through unchanged. */
export function resolveFrontendDist(
  candidates: Array<string | null | undefined>,
  cwd = process.cwd(),
): string {
  const absolute = (c: string) => (isAbsolute(c) ? c : resolve(cwd, c))
  for (const c of candidates) {
    if (!c || c === 'undefined') continue
    const abs = absolute(c)
    if (existsSync(join(abs, 'index.html'))) return abs
  }
  const fallback = [...candidates].reverse().find((c) => c && c !== 'undefined')
  return fallback ? absolute(fallback) : resolve(cwd, 'frontend', 'dist')
}

export function mountFrontend(app: Express, frontendDist: string): void {
  if (!existsSync(frontendDist)) return
  app.use(express.static(frontendDist))
  // See index.ts: '/{*splat}' matches '/', '/products' and '/a/b/c' on Express 5.
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(join(frontendDist, 'index.html'))
  })
}
