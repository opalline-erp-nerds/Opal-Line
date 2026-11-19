import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Expenses must survive a reload and must only reach the accounting journal
// when approved. Re-approving or editing an approved row replaces the same
// journal entry instead of posting a duplicate.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'expenses add, edit, approve, reject, delete and journal sync',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dbRouter } = await import('./db')
    const { ensureDefaultAccounts, removeJournalEntry } = await import('../accounting/journal')
    const { removeExpenseJournal } = await import('../accounting/postings')
    const { and, eq } = await import('drizzle-orm')
    assert.ok(db, 'test database client did not initialize')
    await ensureDefaultAccounts()

    const marker = `expense-${Date.now()}`
    const userId = `${marker}-admin`
    const userName = `${marker} Administrator`
    let expenseId = ''

    const balance = async (code: string) => {
      const [row] = await db!
        .select({ currentBalance: schema.accounts.currentBalance })
        .from(schema.accounts)
        .where(eq(schema.accounts.code, code))
        .limit(1)
      return Number(row?.currentBalance ?? 0)
    }
    const journalFor = async (id: string) => {
      const [entry] = await db!
        .select()
        .from(schema.journalEntries)
        .where(and(eq(schema.journalEntries.referenceType, 'expense'), eq(schema.journalEntries.referenceId, id)))
        .limit(1)
      if (!entry) return { entry: null, lines: [] as Array<typeof schema.journalEntryLines.$inferSelect> }
      const lines = await db!
        .select()
        .from(schema.journalEntryLines)
        .where(eq(schema.journalEntryLines.journalEntryId, entry.id))
      return { entry, lines }
    }

    let server: Server | null = null
    try {
      await db.insert(schema.users).values({
        id: userId,
        name: userName,
        email: `${marker}@test.local`,
        role: 'Super Admin',
        status: 'active',
      })

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = userId
        next()
      })
      app.use(dbRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: res.status, body: (await res.json()) as any }
      }

      const expenseBase = await balance('5004')
      const bankBase = await balance('1002')

      // ── Add / persistence ────────────────────────────────────────────────
      const created = await call('POST', '/expenses', {
        category: 'Software',
        description: `${marker} subscription`,
        amount: 1250.5,
        paymentMethod: 'UPI',
        date: new Date().toISOString(),
        status: 'pending',
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      expenseId = created.body.id
      assert.equal(created.body.by, userName, 'recorded-by comes from the authenticated user')
      assert.equal(Number(created.body.amount), 1250.5)

      const reloaded = await call('GET', `/expenses/${expenseId}`)
      assert.equal(reloaded.status, 200)
      assert.equal(reloaded.body.description, `${marker} subscription`, 'row persists across a fresh read')
      assert.equal(reloaded.body.status, 'pending')
      assert.equal((await journalFor(expenseId)).entry, null, 'pending expense is not in the ledger')

      // ── Edit ─────────────────────────────────────────────────────────────
      const edited = await call('PATCH', `/expenses/${expenseId}`, {
        category: 'Office',
        description: `${marker} renewed subscription`,
        amount: 1500,
        paymentMethod: 'Card',
      })
      assert.equal(edited.status, 200, JSON.stringify(edited.body))
      assert.equal(edited.body.category, 'Office')
      assert.equal(Number(edited.body.amount), 1500)
      assert.equal(edited.body.paymentMethod, 'Card')
      assert.equal(edited.body.by, userName, 'editing does not rewrite the recorder')
      assert.equal((await journalFor(expenseId)).entry, null)

      // ── Approve / idempotency ────────────────────────────────────────────
      const approved = await call('PATCH', `/expenses/${expenseId}`, { status: 'approved' })
      assert.equal(approved.status, 200, JSON.stringify(approved.body))
      assert.equal(approved.body.status, 'approved')
      const firstJournal = await journalFor(expenseId)
      assert.ok(firstJournal.entry, 'approval posts the expense')
      assert.equal(firstJournal.lines.length, 2)
      assert.equal(
        firstJournal.lines.reduce((sum, line) => sum + Number(line.debit), 0),
        1500,
        'journal debit equals the approved amount',
      )
      assert.equal(await balance('5004'), Math.round((expenseBase + 1500) * 100) / 100)
      assert.equal(await balance('1002'), Math.round((bankBase - 1500) * 100) / 100)

      const approvedAgain = await call('PATCH', `/expenses/${expenseId}`, { status: 'approved' })
      assert.equal(approvedAgain.status, 200)
      const repeated = await db!
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(and(eq(schema.journalEntries.referenceType, 'expense'), eq(schema.journalEntries.referenceId, expenseId)))
      assert.equal(repeated.length, 1, 'repeat approval replaces, never duplicates')
      assert.equal((await journalFor(expenseId)).lines.reduce((sum, line) => sum + Number(line.debit), 0), 1500)
      assert.equal(await balance('5004'), Math.round((expenseBase + 1500) * 100) / 100, 'repeat approval does not double the balance')
      assert.equal(await balance('1002'), Math.round((bankBase - 1500) * 100) / 100, 'repeat approval does not double the bank movement')

      // An edit to an already-approved expense reprices the same journal entry.
      const repriced = await call('PATCH', `/expenses/${expenseId}`, { amount: 1750.25 })
      assert.equal(repriced.status, 200)
      const repricedJournal = await journalFor(expenseId)
      assert.ok(repricedJournal.entry)
      assert.equal(repricedJournal.lines.reduce((sum, line) => sum + Number(line.debit), 0), 1750.25)
      assert.equal(await balance('5004'), Math.round((expenseBase + 1750.25) * 100) / 100)

      // ── Validation ───────────────────────────────────────────────────────
      const badAmount = await call('PATCH', `/expenses/${expenseId}`, { amount: 0 })
      assert.equal(badAmount.status, 400)
      const badStatus = await call('PATCH', `/expenses/${expenseId}`, { status: 'paid' })
      assert.equal(badStatus.status, 400)
      const badMethod = await call('PATCH', `/expenses/${expenseId}`, { paymentMethod: 'Crypto' })
      assert.equal(badMethod.status, 400)
      const afterBad = await call('GET', `/expenses/${expenseId}`)
      assert.equal(Number(afterBad.body.amount), 1750.25, 'rejected validation does not persist')
      assert.equal(afterBad.body.status, 'approved')

      // ── Reject / reverse ─────────────────────────────────────────────────
      const rejected = await call('PATCH', `/expenses/${expenseId}`, { status: 'rejected' })
      assert.equal(rejected.status, 200)
      assert.equal((await journalFor(expenseId)).entry, null, 'rejecting removes the journal')
      assert.equal(await balance('5004'), expenseBase)
      assert.equal(await balance('1002'), bankBase)

      // ── Delete ───────────────────────────────────────────────────────────
      const removed = await call('DELETE', `/expenses/${expenseId}`)
      assert.equal(removed.status, 200)
      assert.equal((await call('GET', `/expenses/${expenseId}`)).status, 404)
      assert.equal((await journalFor(expenseId)).entry, null)
      expenseId = ''
    } finally {
      if (expenseId) {
        await removeExpenseJournal(expenseId).catch(() => undefined)
        await removeJournalEntry('expense', expenseId).catch(() => undefined)
        await db!.delete(schema.expenses).where(eq(schema.expenses.id, expenseId)).catch(() => undefined)
      }
      await db!.delete(schema.users).where(eq(schema.users.id, userId)).catch(() => undefined)
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
