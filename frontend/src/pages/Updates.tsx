import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, Info, Loader2, RefreshCw, RefreshCcw, Rocket, Settings2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/confirm'
import type { UpdateStatusInfo } from '@/types'

interface DesktopBridge {
  getUpdateStatus?: () => Promise<UpdateStatusInfo>
  checkForUpdates?: () => Promise<UpdateStatusInfo>
  downloadUpdate?: () => Promise<UpdateStatusInfo>
  installUpdate?: () => Promise<boolean>
  getUpdatePrefs?: () => Promise<UpdatePrefs>
  setUpdatePrefs?: (prefs: Partial<UpdatePrefs>) => Promise<UpdatePrefs>
  clearUpdateFailure?: () => Promise<UpdateStatusInfo>
}

export interface UpdatePrefs {
  /** Auto-download updates in the background when found. */
  autoDownload: boolean
  /** Install (restart) without asking once the download is verified. */
  autoInstall: boolean
  /** Show the amber banner across the app when an update is available. */
  showBanner: boolean
}

const desktop: DesktopBridge | undefined = (window as unknown as { electronAPI?: DesktopBridge }).electronAPI

const PHASE_LABEL: Record<UpdateStatusInfo['phase'], { text: string; cls: string }> = {
  idle: { text: 'Not checked yet', cls: 'bg-muted text-muted-foreground' },
  checking: { text: 'Checking…', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' },
  'up-to-date': { text: 'Up to date', cls: 'bg-success-100 text-success-700 dark:bg-success-950/40 dark:text-success-300' },
  available: { text: 'Update available', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' },
  downloading: { text: 'Downloading…', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' },
  ready: { text: 'Ready to install', cls: 'bg-primary-100 text-primary-700 dark:bg-primary-100/60 dark:text-primary-300' },
  error: { text: 'Check failed', cls: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' },
}

const MB = (bytes: number | null) => (bytes != null ? `${(bytes / 1048576).toFixed(1)} MB` : null)

export default function UpdatesPage() {
  const [update, setUpdate] = useState<UpdateStatusInfo | null>(null)
  const [prefs, setPrefs] = useState<UpdatePrefs | null>(null)
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const isDesktop = Boolean(desktop)

  useEffect(() => {
    desktop?.getUpdateStatus?.().then(setUpdate).catch(() => undefined)
    desktop?.getUpdatePrefs?.().then(setPrefs).catch(() => undefined)
  }, [])

  // Poll while downloading so the progress bar advances.
  useEffect(() => {
    if (update?.phase !== 'downloading') return
    const t = setInterval(() => {
      desktop?.getUpdateStatus?.().then(setUpdate).catch(() => undefined)
    }, 1000)
    return () => clearInterval(t)
  }, [update?.phase])

  const handleCheck = useCallback(async () => {
    if (!desktop?.checkForUpdates) return
    setBusy('check')
    try {
      const next = await desktop.checkForUpdates()
      setUpdate(next)
      if (next.phase === 'up-to-date') toast.success(`You are on the latest version (${next.current}).`)
      if (next.phase === 'error') toast.error(next.error ?? 'Update check failed')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update check failed')
    } finally {
      setBusy(null)
    }
  }, [])

  const handleDownload = useCallback(async () => {
    if (!desktop?.downloadUpdate) return
    setBusy('download')
    try {
      setUpdate(await desktop.downloadUpdate())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setBusy(null)
    }
  }, [])

  const handleDismissFailure = useCallback(async () => {
    const next = await desktop?.clearUpdateFailure?.().catch(() => null)
    if (next) setUpdate(next)
  }, [])

  const handleInstall = useCallback(async () => {
    if (!desktop?.installUpdate) return
    setBusy('install')
    const ok = await desktop.installUpdate().catch(() => false)
    if (ok) toast.info('Restarting to install the update…')
    else {
      toast.error('Could not start the installer')
      setBusy(null)
    }
  }, [])

  const setPref = async (patch: Partial<UpdatePrefs>) => {
    if (!desktop?.setUpdatePrefs) return
    const next = await desktop.setUpdatePrefs(patch).catch(() => null)
    if (next) setPrefs(next)
  }

  const phase = update ? PHASE_LABEL[update.phase] : null
  const progress = Math.min(100, Math.max(0, Math.round(update?.progress ?? 0)))

  return (
    <div className="mx-auto w-full max-w-[900px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="App Updates"
        subtitle="Check for updates manually or let the app keep itself current automatically."
      />

      {!isDesktop ? (
        <Card>
          <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
            <Info className="h-4 w-4 shrink-0" />
            Updates are managed by the desktop app. In the browser build, download the latest
            installer from the GitHub releases page and run it — it upgrades in place and keeps
            all data.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* A failed automatic install is otherwise invisible - the app just
              stays on the old version with no explanation. */}
          {update?.lastFailure && (
            <Card className="border-red-300 dark:border-red-900">
              <CardContent className="p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                      The last update was not installed
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">{update.lastFailure.reason}</p>
                    {update.lastFailure.at && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Attempted {new Date(update.lastFailure.at).toLocaleString()}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" onClick={handleCheck} disabled={busy !== null}>
                        <RefreshCw className={busy === 'check' ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} />
                        Check again
                      </Button>
                      <Button size="sm" variant="ghost" onClick={handleDismissFailure}>
                        Dismiss
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Current state */}
          <Card>
            <CardContent className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300">
                    <Rocket className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Version {update?.current ?? '…'}</p>
                    {phase && (
                      <span className={`mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${phase.cls}`}>
                        {phase.text}{update?.latest ? ` · latest ${update.latest}` : ''}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={handleCheck} disabled={busy !== null}>
                    {busy === 'check'
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <RefreshCw className="h-4 w-4" />}
                    Check now
                  </Button>
                  {update?.phase === 'available' && (
                    <Button onClick={handleDownload} disabled={busy !== null}>
                      {busy === 'download'
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Download className="h-4 w-4" />}
                      Download
                    </Button>
                  )}
                  {update?.phase === 'ready' && (
                    <Button onClick={handleInstall} disabled={busy !== null}>
                      <RefreshCcw className="h-4 w-4" />
                      Restart &amp; install
                    </Button>
                  )}
                </div>
              </div>

              {update?.phase === 'downloading' && (
                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{update.assetName ?? 'Installer'}</span>
                    <span className="tabular-nums">{progress}% {MB(update.assetSize) ? `of ${MB(update.assetSize)}` : ''}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary-500 transition-all" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}

              {update?.error && (
                <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  {update.error}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Preferences */}
          <Card>
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Automatic updates</h2>
              </div>
              <div className="space-y-4">
                <PrefRow
                  title="Download updates automatically"
                  desc="Fetch new versions in the background as soon as they are released."
                  checked={prefs?.autoDownload ?? true}
                  onChange={(v) => setPref({ autoDownload: v })}
                />
                <PrefRow
                  title="Install without asking"
                  desc="Restart and apply the update as soon as it is downloaded and verified. Otherwise you will be asked."
                  checked={prefs?.autoInstall ?? false}
                  onChange={(v) => setPref({ autoInstall: v })}
                />
                <PrefRow
                  title="Show update banner"
                  desc="Display the amber banner at the top of the app while an update is available or ready."
                  checked={prefs?.showBanner ?? true}
                  onChange={(v) => setPref({ showBanner: v })}
                />
              </div>
              {prefs && (
                <p className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />
                  Preferences are saved on this computer and apply to every future update.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function PrefRow({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{desc}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
