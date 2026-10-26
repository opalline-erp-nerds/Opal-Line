import { useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import { Activity, Download, Eye, FileQuestion, Search, ShieldAlert } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import type { AuditLogEntry } from '@/types'
import { formatDateTime, istDateKey, todayIST } from '@/lib/format'

const moduleTint: Record<string, string> = {
  'Silver Rate': 'bg-warning-50 text-warning-700',
  Shopify: 'bg-info-50 text-info-700',
  Sales: 'bg-success-50 text-success-700',
  Payments: 'bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300',
  Products: 'bg-purple-50 dark:bg-purple-950/40 text-purple-700',
  Inventory: 'bg-info-50 text-info-700',
  Accounting: 'bg-success-50 text-success-700',
  Purchase: 'bg-warning-50 text-warning-700',
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [moduleFilter, setModuleFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [viewLog, setViewLog] = useState<AuditLogEntry | null>(null)

  useEffect(() => {
    dbApi.getAuditLogs().then((d) => {
      setLogs(d)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const modules = useMemo(() => [...new Set(logs.map((l) => l.module))], [logs])
  const users = useMemo(() => [...new Set(logs.map((l) => l.user))], [logs])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs.filter((l) => {
      const matchQ =
        !q ||
        l.action.toLowerCase().includes(q) ||
        l.entity.toLowerCase().includes(q) ||
        l.changes?.toLowerCase().includes(q)
      const matchModule = !moduleFilter || l.module === moduleFilter
      const matchUser = !userFilter || l.user === userFilter
      return matchQ && matchModule && matchUser
    })
  }, [logs, query, moduleFilter, userFilter])

  const columns = useMemo<ColumnDef<AuditLogEntry>[]>(
    () => [
      {
        accessorKey: 'timestamp',
        header: 'Timestamp',
        cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.original.timestamp)}</span>,
      },
      {
        accessorKey: 'action',
        header: 'Activity',
        meta: { headerClassName: 'min-w-[220px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${moduleTint[row.original.module] ?? 'bg-muted text-muted-foreground'}`}>
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">{row.original.action}</p>
              <p className="max-w-[260px] truncate text-[11px] text-muted-foreground">{row.original.changes}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'module',
        header: 'Module',
        cell: ({ row }) => <Badge variant="muted">{row.original.module}</Badge>,
      },
      {
        accessorKey: 'entity',
        header: 'Entity',
        cell: ({ row }) => <span className="font-mono text-[12px] text-foreground">{row.original.entity}</span>,
      },
      {
        accessorKey: 'user',
        header: 'User',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <ShieldAlert className="h-3.5 w-3.5" /> {row.original.user}
          </span>
        ),
      },
      {
        accessorKey: 'ip',
        header: 'IP',
        cell: ({ row }) => (
          row.original.ip ? (
            <span className="font-mono text-[11px] text-muted-foreground">{row.original.ip}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const, headerClassName: 'w-10' },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => setViewLog(row.original)}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View full details</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Audit Logs"
        subtitle="Immutable trail of every action taken across modules — who, what, when and where."
        actions={
          <Button variant="outline" size="sm" onClick={() => exportTable('audit-logs.csv', columns, filtered)}>
            <Download className="h-3.5 w-3.5" /> Export Logs
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard icon={Activity} label="Total Events" value={String(logs.length)} sub="Recorded actions" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <MiniCard icon={FileQuestion} label="Modules" value={String(modules.length)} sub="Across the system" tint="bg-info-50 text-info-700" />
        <MiniCard icon={ShieldAlert} label="System Actions" value={String(logs.filter((l) => l.user === 'System').length)} sub="Automated events" tint="bg-warning-50 text-warning-700" />
        <MiniCard icon={Activity} label="Today" value={String(logs.filter((l) => istDateKey(l.timestamp) === todayIST()).length)} sub="Events today" tint="bg-success-50 text-success-700" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search action, entity, changes..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: 'All Modules' },
                ...modules.map((m) => ({ value: m, label: m })),
              ]}
              value={moduleFilter}
              onValueChange={setModuleFilter}
              className="w-[160px]"
            />
            <Select
              options={[
                { value: '', label: 'All Users' },
                ...users.map((u) => ({ value: u, label: u })),
              ]}
              value={userFilter}
              onValueChange={setUserFilter}
              className="w-[150px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {logs.length} events
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No audit events found"
            onRowClick={setViewLog}
          />
        </CardContent>
      </Card>

      <AppDialog
        open={viewLog !== null}
        onOpenChange={(open) => { if (!open) setViewLog(null) }}
        size="lg"
        title={viewLog?.action ?? ''}
        description={viewLog ? formatDateTime(viewLog.timestamp) : ''}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewLog(null)}>Close</Button>
          </DialogFooter>
        }
      >
          {viewLog && (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">User</span><span className="font-medium">{viewLog.user}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Module</span><Badge variant="muted">{viewLog.module}</Badge></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Entity</span><span className="font-mono text-[12px]">{viewLog.entity}</span></div>
              {viewLog.ip && <div className="flex justify-between"><span className="text-muted-foreground">IP address</span><span className="font-mono text-[12px]">{viewLog.ip}</span></div>}
              <div className="border-t pt-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Changes</p>
                <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px]">{viewLog.changes || '—'}</p>
              </div>
            </div>
          )}
      </AppDialog>
    </div>
  )
}

function MiniCard({ icon: Icon, label, value, sub, tint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; tint: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
          {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
        </div>
      </div>
    </Card>
  )
}
