import { useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import { Activity, Download, ScrollText, Search, ShieldAlert, UserRound, Users } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { dbApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import type { ActivityLogEntry } from '@/types'
import { formatDateTime, istDateKey, todayIST } from '@/lib/format'

const moduleTint: Record<string, string> = {
  'Silver Rate': 'bg-warning-50 text-warning-700',
  Shopify: 'bg-info-50 text-info-700',
  Sales: 'bg-success-50 text-success-700',
  Accounts: 'bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300',
  Inventory: 'bg-info-50 text-info-700',
  Purchase: 'bg-warning-50 text-warning-700',
  System: 'bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300',
}

export default function ActivityLogsPage() {
  const [logs, setLogs] = useState<ActivityLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [moduleFilter, setModuleFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')

  useEffect(() => {
    dbApi.getActivityLogs().then((d) => {
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
        l.details?.toLowerCase().includes(q)
      const matchModule = !moduleFilter || l.module === moduleFilter
      const matchUser = !userFilter || l.user === userFilter
      return matchQ && matchModule && matchUser
    })
  }, [logs, query, moduleFilter, userFilter])

  const columns = useMemo<ColumnDef<ActivityLogEntry>[]>(
    () => [
      {
        accessorKey: 'timestamp',
        header: 'Timestamp',
        cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.original.timestamp)}</span>,
      },
      {
        accessorKey: 'action',
        header: 'Operation',
        meta: { headerClassName: 'min-w-[240px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${moduleTint[row.original.module] ?? 'bg-muted text-muted-foreground'}`}>
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">{row.original.action}</p>
              <p className="max-w-[340px] truncate text-[11px] text-muted-foreground">{row.original.details}</p>
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
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <UserRound className="h-3.5 w-3.5" />
            </div>
            <div>
              <p className="text-[13px] font-medium text-foreground">{row.original.user}</p>
              {row.original.role ? <p className="text-[11px] text-muted-foreground">{row.original.role}</p> : null}
            </div>
          </div>
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
    ],
    [],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Activity Log"
        subtitle="Live record of every operation in the billing software — who did it, what changed, when and from where."
        actions={
          <Button variant="outline" size="sm" onClick={() => exportTable('activity-log.csv', columns, filtered)}>
            <Download className="h-3.5 w-3.5" /> Export Log
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard icon={ScrollText} label="Total Operations" value={String(logs.length)} sub="Recorded events" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <MiniCard icon={Users} label="Users" value={String(users.length)} sub="Who performed actions" tint="bg-info-50 text-info-700" />
        <MiniCard icon={ShieldAlert} label="System Actions" value={String(logs.filter((l) => l.user === 'System').length)} sub="Automated events" tint="bg-warning-50 text-warning-700" />
        <MiniCard icon={Activity} label="Today" value={String(logs.filter((l) => istDateKey(l.timestamp) === todayIST()).length)} sub="Operations today" tint="bg-success-50 text-success-700" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search operation, entity, details..."
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
              <span className="font-semibold text-foreground">{filtered.length}</span> of {logs.length} operations
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No activity recorded yet"
          />
        </CardContent>
      </Card>
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
