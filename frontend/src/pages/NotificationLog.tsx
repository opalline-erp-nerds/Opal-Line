import { toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Send } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { dbApi } from '@/lib/api'
import type { NotificationLogEntry } from '@/types'

const statusVariant = (status: string) => {
  if (status === 'sent' || status === 'ok') return 'default'
  if (status === 'failed') return 'danger'
  return 'secondary'
}

export default function NotificationLogPage() {
  const [entries, setEntries] = useState<NotificationLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [resending, setResending] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await dbApi.getNotificationLog()
      setEntries(res.data)
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      void load()
    })
  }, [load])

  const resend = async (id: string) => {
    setResending(id)
    try {
      await dbApi.resendNotification(id)
      toast.success('Notification re-sent successfully.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to resend')
    } finally {
      setResending(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Notification Log"
        subtitle="History of customer emails & WhatsApp messages, with retry for failed sends."
        actions={
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No notifications sent yet. Notifications appear here when orders are fulfilled, returns processed, or
              scheduled reports go out.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Ref</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {e.createdAt ? new Date(e.createdAt).toLocaleString() : '—'}
                      </TableCell>
                      <TableCell className="text-xs font-medium">{e.kind}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {e.channel}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs">{e.recipient ?? '—'}</TableCell>
                      <TableCell className="max-w-[180px] truncate text-xs">{e.ref ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(e.status)} className="text-xs">
                          {e.status}
                        </Badge>
                        {e.error ? (
                          <p className="mt-1 max-w-[260px] truncate text-xs text-muted-foreground" title={e.error}>
                            {e.error}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {e.status === 'failed' ? (
                          <Button size="sm" variant="outline" onClick={() => void resend(e.id)} disabled={resending === e.id}>
                            <Send className="h-3 w-3" />
                            {resending === e.id ? 'Sending…' : 'Resend'}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
