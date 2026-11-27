import { expect, test } from '@playwright/test'
import { buildDatabaseUrlCandidates, describeDatabaseTarget } from './db'

/**
 * Regression tests for the e2e counter-reset database resolution.
 *
 * The dev stack's cluster is on 47194; the installed app's on 47193. The reset
 * helper used to hardcode 47193, so on the dev stack every run skipped the
 * reset (`ECONNREFUSED 127.0.0.1:47193`) and login counters leaked between
 * runs until the security suite answered 429 instead of 401.
 */

const DEV_DB = 'postgres://postgres:dev@127.0.0.1:47194/opal_line'
const DESKTOP_DB = 'postgres://postgres:desktop@127.0.0.1:47193/opal_line'

test.describe('e2e database URL resolution', () => {
  test('dev stack resets the dev cluster on 47194, not the installed app', () => {
    expect(
      buildDatabaseUrlCandidates({
        baseUrl: 'http://127.0.0.1:47195',
        envFileUrl: DEV_DB,
        desktopUrl: DESKTOP_DB,
      }),
    ).toEqual([DEV_DB, DESKTOP_DB])
  })

  test('installed app target prefers its own cluster and ignores backend/.env', () => {
    expect(
      buildDatabaseUrlCandidates({
        baseUrl: 'http://127.0.0.1:47192',
        envFileUrl: DEV_DB,
        desktopUrl: DESKTOP_DB,
      }),
    ).toEqual([DESKTOP_DB])
  })

  test('an explicit DATABASE_URL always wins', () => {
    const explicit = 'postgres://postgres:ci@127.0.0.1:47198/opal_line'
    expect(
      buildDatabaseUrlCandidates({
        baseUrl: 'http://127.0.0.1:47195',
        envUrl: explicit,
        envFileUrl: DEV_DB,
        desktopUrl: DESKTOP_DB,
      }),
    ).toEqual([explicit, DEV_DB, DESKTOP_DB])
  })

  test('a remote target never falls back to a local cluster', () => {
    expect(
      buildDatabaseUrlCandidates({
        baseUrl: 'https://billing.example.com',
        envFileUrl: DEV_DB,
        desktopUrl: DESKTOP_DB,
      }),
    ).toEqual([])
    const remoteDb = 'postgres://user:secret@db.internal:5432/opal_line'
    expect(
      buildDatabaseUrlCandidates({ baseUrl: 'https://billing.example.com', envUrl: remoteDb }),
    ).toEqual([remoteDb])
  })

  test('duplicate sources are collapsed', () => {
    expect(
      buildDatabaseUrlCandidates({
        baseUrl: 'http://localhost:47195',
        envUrl: DEV_DB,
        envFileUrl: DEV_DB,
      }),
    ).toEqual([DEV_DB])
  })

  test('logged targets carry no credentials', () => {
    expect(describeDatabaseTarget(DEV_DB)).toBe('127.0.0.1:47194/opal_line')
    expect(describeDatabaseTarget('not a url')).toBe('(unparseable database URL)')
  })
})
