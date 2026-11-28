import { useCallback, useEffect, useState } from 'react'
import { Check, CloudUpload, Database, Eye, EyeOff, Loader2, Mail, MessageCircle, Plug, Save, Webhook, Wifi, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { RequireModule } from '@/components/RequirePermission'
import { backupApi, dbApi, shopifyApi } from '@/lib/api'
import type { ConnectionSettings, DbStatus } from '@/types'
import { PageHeader } from '@/components/ui/page-header'
import { EnvConfigSection } from '@/components/EnvConfigSection'

const DEFAULT_CONNECTIONS: ConnectionSettings = {
  shopifyStoreUrl: '',
  shopifyAccessToken: '',
  shopifyApiVersion: '2025-10',
  webhookSecret: '',
  shopifyConfigured: false,
  dbHost: 'localhost',
  dbPort: '5432',
  dbDatabase: 'opal_line',
  dbUser: 'postgres',
  dbPassword: '',
  dbConfigured: false,
}

export default function ConnectionsPage() {
  return (
    <RequireModule module="system">
      <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
        <PageHeader
          title="Connections"
          subtitle="Shopify, database, email, WhatsApp, payments and off-site backup — configure everything from here, no backend access needed."
        />
        <ConnectionsTab />
        <EnvConfigSection />
      </div>
    </RequireModule>
  )
}

function ConnectionsTab() {
  const [conn, setConn] = useState<ConnectionSettings>(DEFAULT_CONNECTIONS)
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [showWebhook, setShowWebhook] = useState(false)
  const [showDbPassword, setShowDbPassword] = useState(false)
  const [testingShopify, setTestingShopify] = useState(false)
  const [shopifyTestResult, setShopifyTestResult] = useState<'ok' | 'fail' | null>(null)
  const [shopifyTestMsg, setShopifyTestMsg] = useState('')
  const [ingest, setIngest] = useState<{ configured: boolean; mailbox: string | null; host: string } | null>(null)
  const [testEmailTo, setTestEmailTo] = useState('')
  const [testingEmail, setTestingEmail] = useState(false)
  const [emailTest, setEmailTest] = useState<{ ok: boolean; to?: string; error?: string } | null>(null)
  const [testingMailbox, setTestingMailbox] = useState(false)
  const [mailboxTest, setMailboxTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [wa, setWa] = useState<{ configured: boolean; phoneNumberId: string | null } | null>(null)
  const [waTestTo, setWaTestTo] = useState('')
  const [testingWa, setTestingWa] = useState(false)
  const [waTest, setWaTest] = useState<{ ok: boolean; error?: string } | null>(null)
  const [hooks, setHooks] = useState<{ healthy: boolean; expectedAddress: string | null; entries: Array<{ topic: string; status: string; address?: string; id?: number }> } | null>(null)
  const [repairingHooks, setRepairingHooks] = useState(false)
  const [offsite, setOffsite] = useState<{ configured: boolean; bucket: string | null; endpoint: string | null } | null>(null)
  const [testingOffsite, setTestingOffsite] = useState(false)
  const [syncingOffsite, setSyncingOffsite] = useState(false)
  const [offsiteMsg, setOffsiteMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      dbApi.getConnectionSettings(),
      dbApi.getDbStatus(),
      backupApi.emailIngestStatus(),
      shopifyApi.whatsappStatus(),
      shopifyApi.webhookHealth(),
      shopifyApi.offsiteBackupStatus(),
    ]).then(([connResult, dbResult, ingestResult, waResult, hooksResult, offsiteResult]) => {
      if (cancelled) return
      if (connResult.status === 'fulfilled') {
        setConn((c) => ({ ...c, ...connResult.value }))
      }
      if (dbResult.status === 'fulfilled') {
        setDbStatus(dbResult.value)
      } else {
        setDbStatus({ connected: false, error: 'Failed to fetch status' })
      }
      if (ingestResult.status === 'fulfilled') setIngest(ingestResult.value)
      if (waResult.status === 'fulfilled') setWa(waResult.value)
      if (hooksResult.status === 'fulfilled') setHooks(hooksResult.value)
      if (offsiteResult.status === 'fulfilled') setOffsite(offsiteResult.value)
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  const testShopify = useCallback(async () => {
    setTestingShopify(true)
    setShopifyTestResult(null)
    setShopifyTestMsg('')
    try {
      const isMasked = (v: string) => /^[•*]+$/.test(v)
      const creds: { shopifyStoreUrl?: string; shopifyAccessToken?: string } = {}
      if (conn.shopifyStoreUrl && !isMasked(conn.shopifyStoreUrl)) creds.shopifyStoreUrl = conn.shopifyStoreUrl
      if (conn.shopifyAccessToken && !isMasked(conn.shopifyAccessToken)) creds.shopifyAccessToken = conn.shopifyAccessToken
      const body = Object.keys(creds).length > 0 ? creds : undefined
      const res = await shopifyApi.testConnection(body)
      setShopifyTestResult(res.ok ? 'ok' : 'fail')
      setShopifyTestMsg(res.ok ? (res.shop ? `Connected to ${res.shop}` : 'Connected successfully') : (res.error || 'Connection failed'))
    } catch {
      setShopifyTestResult('fail')
      setShopifyTestMsg('Connection failed')
    } finally {
      setTestingShopify(false)
    }
  }, [conn.shopifyStoreUrl, conn.shopifyAccessToken])

  const saveConnections = async () => {
    setSaving(true)
    setStatus('idle')
    setError('')
    try {
      const patch: Record<string, string> = {}
      const isMasked = (v: string) => /^[•*]+$/.test(v)
      if (conn.shopifyStoreUrl && !isMasked(conn.shopifyStoreUrl)) patch.shopifyStoreUrl = conn.shopifyStoreUrl
      if (conn.shopifyAccessToken && !isMasked(conn.shopifyAccessToken)) patch.shopifyAccessToken = conn.shopifyAccessToken
      if (conn.shopifyApiVersion) patch.shopifyApiVersion = conn.shopifyApiVersion
      if (conn.webhookSecret && !isMasked(conn.webhookSecret)) patch.webhookSecret = conn.webhookSecret
      if (conn.dbHost && !isMasked(conn.dbHost)) patch.dbHost = conn.dbHost
      if (conn.dbPort && !isMasked(conn.dbPort)) patch.dbPort = conn.dbPort
      if (conn.dbDatabase && !isMasked(conn.dbDatabase)) patch.dbDatabase = conn.dbDatabase
      if (conn.dbUser && !isMasked(conn.dbUser)) patch.dbUser = conn.dbUser
      if (conn.dbPassword && !isMasked(conn.dbPassword)) patch.dbPassword = conn.dbPassword
      const res = await dbApi.updateConnectionSettings(patch)
      setStatus('saved')
      setConn((c) => ({
        ...c,
        shopifyConfigured: Boolean(conn.shopifyStoreUrl && conn.shopifyAccessToken),
        dbConfigured: Boolean(conn.dbHost && conn.dbUser && conn.dbPassword),
      }))
      if (res.shopify) {
        if (res.shopify.ok) {
          setShopifyTestResult('ok')
          if (!res.reconnectError) setError('')
        } else {
          setShopifyTestResult('fail')
          setError(res.shopify.error || 'Shopify connection failed')
          setStatus('error')
        }
      }
      // Refresh DB status after save (may have reconnected)
      if (patch.dbHost || patch.dbPassword || patch.dbUser) {
        setTimeout(async () => {
          try {
            const newStatus = await dbApi.getDbStatus()
            setDbStatus(newStatus)
          } catch { /* ignore */ }
        }, 1500)
      }
      if ((res as any).reconnectError) {
        setError(`DB saved but reconnect failed: ${(res as any).reconnectError}`)
        setStatus('error')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
      setStatus('error')
    } finally {
      setSaving(false)
    }
  }

  const testDbConnection = useCallback(async () => {
    try {
      const status = await dbApi.getDbStatus()
      setDbStatus(status)
    } catch {
      setDbStatus({ connected: false, error: 'Health check failed' })
    }
  }, [])

  const runEmailTest = async () => {
    setTestingEmail(true)
    setEmailTest(null)
    try {
      const res = await shopifyApi.testEmail(testEmailTo.trim() || undefined)
      setEmailTest(res)
    } catch (e) {
      setEmailTest({ ok: false, error: e instanceof Error ? e.message : 'Test failed' })
    } finally {
      setTestingEmail(false)
    }
  }

  const runMailboxTest = async () => {
    setTestingMailbox(true)
    setMailboxTest(null)
    try {
      const r = await shopifyApi.testMailbox()
      if (r.ok) {
        const bits = [r.provider === 'mailtm' ? 'mail.tm' : `IMAP ${r.host ?? ''}`, r.folder, r.messageCount != null ? `${r.messageCount} message(s)` : null].filter(Boolean)
        setMailboxTest({ ok: true, text: `Mailbox login OK — ${bits.join(' · ')}` })
      } else {
        setMailboxTest({ ok: false, text: r.error ?? 'Mailbox login failed' })
      }
    } catch (e) {
      setMailboxTest({ ok: false, text: e instanceof Error ? e.message : 'Test failed' })
    } finally {
      setTestingMailbox(false)
    }
  }

  const runWhatsAppTest = async () => {
    setTestingWa(true)
    setWaTest(null)
    try {
      const res = await shopifyApi.testWhatsApp(waTestTo.trim())
      setWaTest(res)
    } catch (e) {
      setWaTest({ ok: false, error: e instanceof Error ? e.message : 'Test failed' })
    } finally {
      setTestingWa(false)
    }
  }

  const runWebhookRepair = async () => {
    setRepairingHooks(true)
    try {
      const res = await shopifyApi.repairWebhooks()
      setHooks((h) => ({ expectedAddress: h?.expectedAddress ?? null, healthy: res.healthy, entries: res.entries }))
    } catch { /* keep previous state */ } finally {
      setRepairingHooks(false)
    }
  }

  const runOffsiteTest = async () => {
    setTestingOffsite(true)
    setOffsiteMsg(null)
    try {
      const res = await shopifyApi.testOffsiteBackup()
      setOffsiteMsg(res.ok ? { ok: true, text: `Bucket reachable: ${res.bucket}` } : { ok: false, text: res.error ?? 'Connection failed' })
    } catch (e) {
      setOffsiteMsg({ ok: false, text: e instanceof Error ? e.message : 'Test failed' })
    } finally {
      setTestingOffsite(false)
    }
  }

  const runOffsiteSync = async () => {
    setSyncingOffsite(true)
    setOffsiteMsg(null)
    try {
      const res = await shopifyApi.syncOffsiteBackup()
      setOffsiteMsg(res.ok ? { ok: true, text: `Uploaded ${res.uploaded.length} file(s), ${res.skipped} already current.` } : { ok: false, text: res.error ?? 'Sync failed' })
    } catch (e) {
      setOffsiteMsg({ ok: false, text: e instanceof Error ? e.message : 'Sync failed' })
    } finally {
      setSyncingOffsite(false)
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground">Shopify Configuration</h3>
            </div>
            {conn.shopifyConfigured ? (
              <span className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400"><Wifi className="h-3 w-3" /> Connected</span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><WifiOff className="h-3 w-3" /> Not connected</span>
            )}
          </div>

          <Field label="Store URL (subdomain)">
            <Input
              placeholder="e.g. testing-nnwap2fl"
              value={conn.shopifyStoreUrl}
              onChange={(e) => setConn((c) => ({ ...c, shopifyStoreUrl: e.target.value }))}
            />
          </Field>

          <Field label="Access Token">
            <div className="relative">
              <Input
                type={showToken ? 'text' : 'password'}
                placeholder="shpat_xxxxxxxxxxxxxxxx"
                value={conn.shopifyAccessToken}
                onChange={(e) => setConn((c) => ({ ...c, shopifyAccessToken: e.target.value }))}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>

          <Field label="API Version">
            <Input
              value={conn.shopifyApiVersion}
              onChange={(e) => setConn((c) => ({ ...c, shopifyApiVersion: e.target.value }))}
            />
          </Field>

          <Field label="Webhook Secret (optional)">
            <div className="relative">
              <Input
                type={showWebhook ? 'text' : 'password'}
                placeholder="Your Shopify webhook HMAC secret"
                value={conn.webhookSecret}
                onChange={(e) => setConn((c) => ({ ...c, webhookSecret: e.target.value }))}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowWebhook(!showWebhook)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showWebhook ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>

          <div className="flex items-center gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={testShopify} disabled={testingShopify || !loaded}>
              {testingShopify ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              {testingShopify ? 'Testing...' : 'Test Connection'}
            </Button>
            {shopifyTestResult === 'ok' && <span className="text-xs font-medium text-green-600 dark:text-green-400">{shopifyTestMsg || 'Connected successfully'}</span>}
            {shopifyTestResult === 'fail' && <span className="text-xs font-medium text-red-600 dark:text-red-400 max-w-[28rem]">{shopifyTestMsg || 'Connection failed'}</span>}
          </div>

          <p className="text-xs text-muted-foreground">
            Secrets are encrypted with AES-256-GCM and stored securely in the database.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground">Database Connection</h3>
            </div>
            {dbStatus ? (
              dbStatus.connected ? (
                <span className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
                  <Wifi className="h-3 w-3" /> Connected
                  {dbStatus.latencyMs != null && <span className="text-muted-foreground ml-1">{dbStatus.latencyMs}ms</span>}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400"><WifiOff className="h-3 w-3" /> Disconnected</span>
              )
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Checking...</span>
            )}
          </div>

          <Field label="Host">
            <Input
              placeholder="localhost"
              value={conn.dbHost}
              onChange={(e) => setConn((c) => ({ ...c, dbHost: e.target.value }))}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Port">
              <Input
                placeholder="5432"
                value={conn.dbPort}
                onChange={(e) => setConn((c) => ({ ...c, dbPort: e.target.value }))}
              />
            </Field>
            <Field label="Database">
              <Input
                placeholder="opal_line"
                value={conn.dbDatabase}
                onChange={(e) => setConn((c) => ({ ...c, dbDatabase: e.target.value }))}
              />
            </Field>
          </div>

          <Field label="User">
            <Input
              placeholder="postgres"
              value={conn.dbUser}
              onChange={(e) => setConn((c) => ({ ...c, dbUser: e.target.value }))}
            />
          </Field>

          <Field label="Password">
            <div className="relative">
              <Input
                type={showDbPassword ? 'text' : 'password'}
                placeholder="Enter database password"
                value={conn.dbPassword}
                onChange={(e) => setConn((c) => ({ ...c, dbPassword: e.target.value }))}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowDbPassword(!showDbPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showDbPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>

          {dbStatus?.error && (
            <p className="text-xs text-red-500 dark:text-red-400">{dbStatus.error}</p>
          )}

          {dbStatus?.connected && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <Label className="text-xs text-muted-foreground">Host</Label>
                <p className="font-mono text-foreground">{dbStatus.host || '—'}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Port</Label>
                <p className="font-mono text-foreground">{dbStatus.port || '—'}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Database</Label>
                <p className="font-mono text-foreground">{dbStatus.database || '—'}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">User</Label>
                <p className="font-mono text-foreground">{dbStatus.user || '—'}</p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={testDbConnection} disabled={!loaded}>
              <Database className="h-4 w-4" />
              Test Connection
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Database credentials are encrypted and stored securely. Saving new credentials will reconnect the server.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground">Email / Order Ingest</h3>
            </div>
            {ingest ? (
              ingest.configured ? (
                <span className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400"><Wifi className="h-3 w-3" /> Mailbox ready</span>
              ) : (
                <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><WifiOff className="h-3 w-3" /> Not configured</span>
              )
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Checking...</span>
            )}
          </div>

          {ingest?.configured && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <Label className="text-xs text-muted-foreground">Mailbox</Label>
                <p className="font-mono text-foreground">{ingest.mailbox ?? '—'}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">IMAP Host</Label>
                <p className="font-mono text-foreground">{ingest.host}</p>
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Shopify "New order" notification emails are read from the mailbox via IMAP and converted into orders.
            Outgoing alerts use RESEND_API_KEY or Gmail SMTP (NOTIFICATION_SMTP_* vars).
            Use <span className="font-medium">Send Test Email</span> to check outgoing mail and <span className="font-medium">Test Mailbox</span> to check the order-ingest inbox.
          </p>

          <div className="space-y-2 pt-1">
            <Field label="Send test email to">
              <Input
                type="email"
                placeholder="owner@example.com (blank = NOTIFICATION_EMAIL)"
                value={testEmailTo}
                onChange={(e) => setTestEmailTo(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={runEmailTest} disabled={testingEmail}>
                {testingEmail ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {testingEmail ? 'Sending...' : 'Send Test Email'}
              </Button>
              <Button size="sm" variant="outline" onClick={runMailboxTest} disabled={testingMailbox}>
                {testingMailbox ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {testingMailbox ? 'Checking...' : 'Test Mailbox (IMAP)'}
              </Button>
              {emailTest && (
                emailTest.ok
                  ? <span className="text-xs font-medium text-green-600 dark:text-green-400">Sent to {emailTest.to}</span>
                  : <span className="text-xs font-medium text-red-600 dark:text-red-400 max-w-[22rem]">{emailTest.error}</span>
              )}
              {mailboxTest && (
                <span className={`text-xs font-medium ${mailboxTest.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400 max-w-[22rem]'}`}>{mailboxTest.text}</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground">WhatsApp</h3>
            </div>
            {wa ? (
              wa.configured
                ? <span className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400"><Wifi className="h-3 w-3" /> Connected</span>
                : <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><WifiOff className="h-3 w-3" /> Not configured</span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Checking...</span>
            )}
          </div>

          {wa?.configured && wa.phoneNumberId && (
            <div className="text-sm">
              <Label className="text-xs text-muted-foreground">Phone Number ID</Label>
              <p className="font-mono text-foreground">{wa.phoneNumberId}</p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            WhatsApp notifications use the Meta Cloud API. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in backend/.env to enable.
          </p>

          <div className="space-y-2 pt-1">
            <Field label="Send test message to">
              <Input
                placeholder="10-digit mobile number"
                value={waTestTo}
                onChange={(e) => setWaTestTo(e.target.value)}
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={runWhatsAppTest} disabled={testingWa || waTestTo.trim().length < 10}>
                {testingWa ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
                {testingWa ? 'Sending...' : 'Send Test WhatsApp'}
              </Button>
              {waTest && (
                waTest.ok
                  ? <span className="text-xs font-medium text-green-600 dark:text-green-400">Message sent</span>
                  : <span className="text-xs font-medium text-red-600 dark:text-red-400 max-w-[20rem]">{waTest.error}</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Webhook className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground">Shopify Webhooks</h3>
            </div>
            {hooks ? (
              hooks.healthy
                ? <span className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400"><Check className="h-3 w-3" /> All registered</span>
                : <span className="flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">Issues found</span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Checking...</span>
            )}
          </div>

          {hooks && (
            <div className="space-y-1">
              {hooks.entries.map((e) => (
                <div key={e.topic} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-foreground">{e.topic}</span>
                  <Badge variant={e.status === 'registered' ? 'success' : e.status === 'stale' ? 'warning' : 'danger'}>{e.status}</Badge>
                </div>
              ))
              }
            </div>
          )}

          {hooks && !hooks.expectedAddress && (
            <p className="text-xs text-muted-foreground">Set PUBLIC_BASE_URL in backend/.env (a public https URL) so Shopify can reach the webhook endpoint.</p>
          )}

          <Button size="sm" variant="outline" onClick={runWebhookRepair} disabled={repairingHooks}>
            {repairingHooks ? <Loader2 className="h-4 w-4 animate-spin" /> : <Webhook className="h-4 w-4" />}
            {repairingHooks ? 'Repairing...' : 'Verify & Repair Webhooks'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CloudUpload className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground">Off-Site Backup</h3>
            </div>
            {offsite ? (
              offsite.configured
                ? <span className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400"><Wifi className="h-3 w-3" /> {offsite.bucket}</span>
                : <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><WifiOff className="h-3 w-3" /> Not configured</span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Checking...</span>
            )}
          </div>

          {offsite?.configured && offsite.endpoint && (
            <div className="text-sm">
              <Label className="text-xs text-muted-foreground">Endpoint</Label>
              <p className="truncate font-mono text-xs text-foreground">{offsite.endpoint}</p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Every auto backup is pushed to any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2). Set BACKUP_OFFSITE_ENDPOINT / BUCKET / KEY_ID / SECRET in backend/.env.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={runOffsiteTest} disabled={testingOffsite}>
              {testingOffsite ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              Test Bucket
            </Button>
            <Button size="sm" variant="outline" onClick={runOffsiteSync} disabled={syncingOffsite || !offsite?.configured}>
              {syncingOffsite ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
              {syncingOffsite ? 'Uploading...' : 'Sync Now'}
            </Button>
          </div>
          {offsiteMsg && (
            <p className={`text-xs font-medium ${offsiteMsg.ok ? 'text-success-700' : 'text-destructive'}`}>{offsiteMsg.text}</p>
          )}
        </CardContent>
      </Card>

      <div className="lg:col-span-2 flex items-center justify-end gap-3">
        {status === 'saved' && (
          <span className="flex items-center gap-1.5 text-sm font-medium text-success-600">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        {status === 'error' && <span className="text-sm font-medium text-red-600 dark:text-red-400">{error}</span>}
        <Button size="sm" onClick={saveConnections} disabled={saving || !loaded}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving...' : 'Save Connections'}
        </Button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
