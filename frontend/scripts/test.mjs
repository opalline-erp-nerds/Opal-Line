// Runs the frontend test suite through tsx.
//
// Two tsx limitations shape this launcher:
//   * `@/*` aliases come from the tsconfig tsx finds at the process cwd, so
//     the child runs with cwd = frontend/ (its tsconfig.json mirrors the
//     `paths` mapping from tsconfig.app.json).
//   * tsx only applies `jsx: react-jsx` from an auto-detected non-solution
//     config; the solution-style tsconfig.json (`files: []` + `references`)
//     is ignored, so JSX under src/ compiles with the classic runtime. The
//     React shim puts `React` on the global object for `React.createElement`
//     lookups; automatic-runtime output is unaffected by it.
// npm scripts cannot set an environment variable portably (Windows cmd has no
// `VAR=value cmd` syntax), which is why this is a script instead of a one-liner.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..')
const shim = pathToFileURL(join(here, 'jsx-shim.mjs')).href

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return collect(full)
    return /\.test\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const files = collect(join(frontend, 'src'))
// tests/ holds cross-package parity checks (e.g. preview vs backend PDF
// geometry) that import from ../../backend; they belong to the same suite.
const crossDir = join(frontend, 'tests')
if (existsSync(crossDir)) files.push(...collect(crossDir))
if (files.length === 0) {
  console.error('No test files found under src/.')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--import', shim, '--test', '--test-force-exit', ...files],
  { cwd: frontend, stdio: 'inherit' },
)

process.exit(result.status ?? 1)
