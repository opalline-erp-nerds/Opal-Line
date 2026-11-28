import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  Info,
  Loader2,
  Network,
  RefreshCw,
  Rocket,
  ScrollText,
  Server,
  ShieldCheck,
  Terminal,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { systemApi } from '@/lib/api'
import type { SystemLogFileInfo, SystemPortInfo, SystemStatusInfo, UpdateStatusInfo } from '@/types'

interface DesktopBridge {
  isElectron?: boolean
  getUpdateStatus?: () => Promise<UpdateStatusInfo>
  checkForUpdates?: () => Promise<UpdateStatusInfo>
  downloadUpdate?: () => Promise<UpdateStatusInfo>
  installUpdate?: () => Promise<boolean>
}

const desktop: DesktopBridge | undefined = (window as unknown as { electronAPI?: DesktopBridge }).electronAPI

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m ${sec % 60}s`
}

const phaseBadge: Record<UpdateStatusInfo['phase'], { label: string; cls: string }> = {
  idle: { label: 'Not checked yet', cls: 'bg-muted text-muted-foreground' },
  checking: { label: 'Checking…', cls: 'bg-info-50 text-info-700' },
  'up-to-date': { label: 'Up to date', cls: 'bg-success-50 text-success-700' },
  available: { label: 'Update available', cls: 'bg-warning-50 text-warning-700' },
  downloading: { label: 'Downloading…', cls: 'bg-info-50 text-info-700' },
  ready: { label: 'Ready to install', cls: 'bg-success-50 text-success-700' },
  error: { label: 'Update check failed', cls: 'bg-red-50 text-red-700' },
}

function StatTile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold text-foreground">{value}</p>
        {sub ? <p className="truncate text-[11px] text-muted-foreground">{sub}</p> : null}
      </div>
    </div>
  )
}

export default function SystemStatusPage() {
  const [status, setStatus] = useState<SystemStatusInfo | null>(null)
  const [statusErr, setStatusErr] = useState<string | null>(null)
  const [logFiles, setLogFiles] = useState<SystemLogFileInfo[]>([])
  const [logDir, setLogDir] = useState('')
  const [activeLog, setActiveLog] = useState('app')
  const [lines, setLines] = useState<string[]>([])
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [update, setUpdate] = useState<UpdateStatusInfo | null>(null)
  const [ports, setPorts] = useState<SystemPortInfo[] | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  const loadStatus = useCallback(() => {
    systemApi
      .status()
      .then((s) => {
        setStatus(s)
        setStatusErr(null)
      })
      .catch((e: unknown) => setStatusErr(e instanceof Error ? e.message : 'Failed to load system status'))
  }, [])

  const loadPorts = useCallback(() => {
    systemApi
      .ports()
      .then((p) => setPorts(p.ports))
      .catch(() => setPorts(null))
  }, [])

  const loadLogs = useCallback(
    (file?: string) => {
      const key = file ?? activeLog
      systemApi
        .logs(key, 250)
        .then((tail) => {
          setLines(tail.lines)
          setLogDir(tail.directory)
        })
        .catch(() => setLines([]))
      systemApi
        .logFiles()
        .then((meta) => setLogFiles(meta.files))
        .catch(() => setLogFiles([]))
    },
    [activeLog],
  )

  useEffect(() => {
    loadStatus()
    loadPorts()
  }, [loadPorts, loadStatus])

  useEffect(() => {
    loadLogs(activeLog)
  }, [loadLogs, activeLog])

  useEffect(() => {
    if (!autoRefresh) return
    // Four requests every 5s is only useful while someone is watching this
    // page. Pause the timer in a hidden tab and refresh once on return.
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      loadLogs(activeLog)
      loadStatus()
      loadPorts()
    }
    const t = setInterval(tick, 5000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [autoRefresh, activeLog, loadLogs, loadPorts, loadStatus])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  useEffect(() => {
    desktop?.getUpdateStatus?.().then(setUpdate).catch(() => undefined)
  }, [])

  async function handleCheck() {
    if (!desktop?.checkForUpdates) return
    setUpdateBusy(true)
    setUpdateMsg(null)
    try {
      setUpdate(await desktop.checkForUpdates())
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : 'Update check failed')
    } finally {
      setUpdateBusy(false)
    }
  }

  async function handleDownload() {
    if (!desktop?.downloadUpdate) return
    setUpdateBusy(true)
    setUpdateMsg(null)
    try {
      setUpdate(await desktop.downloadUpdate())
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setUpdateBusy(false)
    }
  }

  async function handleInstall() {
    if (!desktop?.installUpdate) return
    setUpdateBusy(true)
    const ok = await desktop.installUpdate().catch(() => false)
    setUpdateMsg(ok ? 'Restarting into the installer…' : 'Could not start the installer')
    if (!ok) setUpdateBusy(false)
  }

  const phase = update ? phaseBadge[update.phase] : null
  const badgeCls = `inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${phase?.cls ?? 'bg-muted text-muted-foreground'}`

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="System Status"
        subtitle="Live server health, software updates and server logs."
        actions={
          <Button variant="outline" onClick={() => { loadStatus(); loadPorts(); loadLogs(activeLog) }}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {statusErr ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
          <AlertTriangle className="h-4 w-4" /> {statusErr}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          icon={<Rocket className="h-4 w-4" />}
          label="Application"
          value={status ? `v${status.app.version}` : '…'}
          sub={status ? `${status.runtime.platform}/${status.runtime.arch} · ${status.runtime.env ?? 'no env'}` : undefined}
        />
        <StatTile
          icon={<Server className="h-4 w-4" />}
          label="Server"
          value={status ? `Port ${status.server.port}` : '…'}
          sub={status ? `up ${formatUptime(status.server.uptimeSec)} · ${status.server.rssMb} MB RAM` : undefined}
        />
        <StatTile
          icon={<Database className="h-4 w-4" />}
          label="Database"
          value={
            status ? (
              <span className="flex items-center gap-1.5">
                {status.database.healthy ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-success-600" /> Healthy
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-red-600" /> Unhealthy
                  </>
                )}
                {status.database.latencyMs != null ? <span className="font-normal text-muted-foreground">· {status.database.latencyMs} ms</span> : null}
              </span>
            ) : (
              '…'
            )
          }
          sub={
            status?.database.stats
              ? `${status.database.stats.totalConnections} connections (${status.database.stats.idleConnections} idle)`
              : status
                ? 'No connection stats'
                : undefined
          }
        />
        <StatTile
          icon={<Info className="h-4 w-4" />}
          label="Runtime"
          value={status ? status.runtime.node : '…'}
          sub={status ? `heap ${status.server.heapMb} MB · ${status.server.sessions.active} active session(s)` : undefined}
        />
        <StatTile
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Integrations"
          value={
            status ? (
              <span className="flex flex-wrap gap-1.5">
                <span className={badgeCls + (status.integrations.shopify ? ' bg-success-50 text-success-700' : '')}>Shopify {status.integrations.shopify ? 'on' : 'off'}</span>
                <span className={badgeCls + (status.integrations.emailIngest ? ' bg-success-50 text-success-700' : '')}>Email ingest {status.integrations.emailIngest ? 'on' : 'off'}</span>
              </span>
            ) : (
              '…'
            )
          }
          sub={status?.paths.env ? `env: ${status.paths.env}` : undefined}
        />
        <StatTile
          icon={<ScrollText className="h-4 w-4" />}
          label="Log directory"
          value={logDir ? 'Available' : '…'}
          sub={logDir || undefined}
        />
      </div>

      {/* ── Opal Line port block — who holds 47191–47198 ── */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Port block 47191–47198</h2>
            </div>
            <Button variant="ghost" size="sm" onClick={loadPorts}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
          {ports ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {ports.map((p) => (
                <div key={p.port} className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold tabular-nums text-foreground">
                      {p.port}
                      <span className="ml-1.5 font-normal text-muted-foreground">{p.label}</span>
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {p.inUse
                        ? `${p.process ?? 'process unknown'} · PID ${p.pid ?? '?'}${p.isSelf ? ' · this server' : ''}`
                        : 'Free'}
                    </p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      p.inUse ? 'bg-warning-50 text-warning-700' : 'bg-success-50 text-success-700'
                    }`}
                  >
                    {p.inUse ? 'In use' : 'Free'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">Port list unavailable.</p>
          )}
        </CardContent>
      </Card>

      {/* ── Software updates (desktop app only) ── */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Software updates</h2>
              {update ? <span className={badgeCls}>{phase?.label}</span> : null}
            </div>
            <div className="flex items-center gap-2">
              {update?.phase === 'available' ? (
                <Button onClick={() => void handleDownload()} disabled={updateBusy}>
                  {updateBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Download update
                </Button>
              ) : null}
              {update?.phase === 'downloading' ? (
                <Button onClick={() => void handleDownload()} disabled>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Downloading… {update.progress}%
                </Button>
              ) : null}
              {update?.phase === 'ready' ? (
                <Button onClick={() => void handleInstall()} disabled={updateBusy}>
                  <Rocket className="h-4 w-4" />
                  Restart & install
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => void handleCheck()} disabled={updateBusy || update?.phase === 'downloading'}>
                {updateBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Check for updates
              </Button>
            </div>
          </div>

          {update?.phase === 'downloading' ? (
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${update.progress}%` }} />
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {update
              ? update.phase === 'error'
                ? `Last check failed: ${update.error ?? 'unknown error'}`
                : update.latest
                  ? `Installed ${update.current} · latest release ${update.latest}${update.assetName ? ` · ${update.assetName}` : ''}`
                  : `Installed ${update.current}`
              : 'Updates are checked automatically every 6 hours.'}
            {updateMsg ? ` · ${updateMsg}` : ''}
          </p>

          {!desktop?.isElectron ? (
            <div className="flex items-center gap-2 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" /> Update checks and installs run inside the desktop app. Open the installed app to manage updates.
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Server logs ── */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Server logs</h2>
              {logDir ? <span className="text-[11px] text-muted-foreground">{logDir}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {logFiles.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setActiveLog(f.key)}
                  className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                    activeLog === f.key
                      ? 'border-primary bg-primary/10 font-semibold text-primary-700'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {f.name}
                  {f.sizeKb > 0 ? ` · ${f.sizeKb} KB` : ''}
                </button>
              ))}
              <Button variant="outline" size="sm" onClick={() => setAutoRefresh((v) => !v)} className="ml-1">
                Auto-refresh: {autoRefresh ? 'On' : 'Off'}
              </Button>
            </div>
          </div>

          <div className="max-h-[420px] overflow-auto rounded-md border bg-black/95 p-3 font-mono text-[11px] leading-relaxed text-green-100">
            {lines.length === 0 ? (
              <p className="text-muted-foreground">No log entries (file may not exist yet).</p>
            ) : (
              lines.map((l, i) => (
                <div key={`${i}-${l.slice(0, 24)}`} className="whitespace-pre-wrap break-all">
                  {l}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
          <p className="text-[11px] text-muted-foreground">Last {lines.length} line(s). {autoRefresh ? 'Refreshes every 5 seconds.' : 'Auto-refresh is off.'}</p>
        </CardContent>
      </Card>
    </div>
  )
}
