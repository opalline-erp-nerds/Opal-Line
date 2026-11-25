'use strict'

/**
 * Shared portable-PostgreSQL bundling logic.
 *
 * backend/pgsql is NOT in git (~1 GB of binaries), so a fresh clone has no
 * server. Both callers need the same fetch: scripts/build-desktop.js bundles
 * it into the installer, and scripts/dev.mjs downloads it on demand so
 * `npm run dev` works on any Windows machine without a system PostgreSQL.
 *
 * The EnterpriseDB "binaries" zip is a full development distribution: it
 * ships pgAdmin 4 (~16,600 files), StackBuilder, server headers, the full
 * docs tree and debug symbols. None of it is used at runtime — we only ever
 * exec bin/initdb.exe + bin/pg_ctl.exe and let them load lib/ and share/.
 * Shipping it verbatim added ~700 MB to the installer and made electron-builder
 * code-sign ~20,000 files one at a time (a >1 hour build), so it is pruned.
 */

const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')

const PG_VERSION = '16.4'
const PG_URL = `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-1-windows-x64-binaries.zip`
const PG_PRUNE_DIRS = ['pgAdmin 4', 'StackBuilder', 'doc', 'include', 'symbols']

function prunePortablePostgres(pgDir, log = console.log) {
  let removed = 0
  for (const dir of PG_PRUNE_DIRS) {
    const target = path.join(pgDir, dir)
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true })
      removed++
    }
  }
  if (removed > 0) log(`  Pruned ${removed} unused PostgreSQL director${removed === 1 ? 'y' : 'ies'} (pgAdmin 4, StackBuilder, doc, include, symbols).`)
}

function downloadTo(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const fail = (err) => {
      file.close(() => {})
      fs.rmSync(dest, { force: true })
      reject(err)
    }
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects > 5) return fail(new Error('Too many redirects'))
          return downloadTo(res.headers.location, dest, redirects + 1).then(resolve, reject)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return fail(new Error(`HTTP ${res.statusCode} for ${url}`))
        }
        res.pipe(file)
        file.on('finish', () => file.close(resolve))
        file.on('error', fail)
      })
      .on('error', fail)
  })
}

/**
 * Expand a downloaded EDB zip into pgDir. The archive's top-level folder is
 * always `pgsql/` (bin/, lib/, share/…). Throws on an unexpected layout.
 * Split out from the download so it can be tested with a local fixture zip.
 */
function extractPortablePostgresZip(zipPath, pgDir, { log = console.log } = {}) {
  const tmpRoot = `${pgDir}-extract-tmp`
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  fs.mkdirSync(tmpRoot, { recursive: true })
  try {
    log('  Extracting…')
    const extractOptions = { stdio: 'inherit', timeout: 10 * 60 * 1000 }
    try {
      execFileSync('tar', ['-xf', zipPath, '-C', tmpRoot], extractOptions)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      log('  tar unavailable; falling back to pwsh Expand-Archive.')
      const quotePowerShell = (value) => `'${value.replace(/'/g, "''")}'`
      const command =
        `Expand-Archive -Path ${quotePowerShell(zipPath)} ` +
        `-DestinationPath ${quotePowerShell(tmpRoot)} -Force`
      execFileSync('pwsh', ['-NoProfile', '-Command', command], extractOptions)
    }
    const extracted = path.join(tmpRoot, 'pgsql')
    if (!fs.existsSync(path.join(extracted, 'bin', 'pg_ctl.exe'))) {
      throw new Error('unexpected archive layout (no pgsql/bin/pg_ctl.exe inside)')
    }
    fs.rmSync(pgDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(pgDir), { recursive: true })
    fs.renameSync(extracted, pgDir)
    prunePortablePostgres(pgDir, log)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
  return pgDir
}

/**
 * Make sure pgDir holds a pruned, runnable portable PostgreSQL.
 * Returns 'present' (already there) or 'downloaded'; THROWS on failure so
 * callers decide whether that is fatal (installer build: yes; dev: falls back
 * to the "install PostgreSQL yourself" guidance).
 */
async function ensurePortablePostgres(pgDir, { log = console.log } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('the portable PostgreSQL bundle is Windows-only')
  }
  if (fs.existsSync(path.join(pgDir, 'bin', 'pg_ctl.exe'))) {
    log('  PostgreSQL already bundled.')
    prunePortablePostgres(pgDir, log)
    return 'present'
  }
  log(`  Downloading portable PostgreSQL ${PG_VERSION} (~330 MB)…`)
  const zip = `${pgDir}.tmp.zip`
  try {
    await downloadTo(PG_URL, zip)
    await extractPortablePostgresZip(zip, pgDir, { log })
    fs.rmSync(zip, { force: true })
    log(`  PostgreSQL ready at ${pgDir}`)
    return 'downloaded'
  } catch (err) {
    fs.rmSync(zip, { force: true })
    throw err
  }
}

module.exports = {
  PG_VERSION,
  PG_URL,
  PG_PRUNE_DIRS,
  prunePortablePostgres,
  extractPortablePostgresZip,
  ensurePortablePostgres,
}
