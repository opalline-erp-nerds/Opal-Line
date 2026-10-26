import { Link, useNavigate } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import { ArrowUpRight, ArrowDownRight, Bell, FileText, Gem, Menu, Moon, Plus, Settings, ShieldCheck, ShoppingBag, Sun, UserPlus, ChevronDown, LogOut, RefreshCcw, Search } from 'lucide-react'
import { useAuth } from '@/auth/auth-context'
import { useSilverRate } from '@/lib/silver-rate-context'
import { formatDateTime } from '@/lib/format'
import { initials } from '@/lib/utils'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { dbApi } from '@/lib/api'
import { getTheme, toggleTheme, type Theme } from '@/lib/theme'
import type { Activity } from '@/types'

interface HeaderProps {
  onToggleSidebar: () => void
  onOpenSearch: () => void
}

export function Header({ onToggleSidebar, onOpenSearch }: HeaderProps) {
  const { rate: silverRate } = useSilverRate()
  const { currentUser, logout, refresh, permissionsMeta, hasPermission } = useAuth()
  const navigate = useNavigate()
  const [theme, setThemeState] = useState<Theme>(() => getTheme())
  const [notifications, setNotifications] = useState<Activity[]>([])
  const [feed, setFeed] = useState<Array<{ type: string; title: string; detail: string | null; at: string | null; href: string }>>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null)
  const [pendingRateRequests, setPendingRateRequests] = useState(0)

  // Only Admin / Super Admin can act on queued silver-rate requests.
  const isRateApprover = currentUser?.role === 'Admin' || currentUser?.role === 'Super Admin'

  const rate = silverRate?.rate ?? null
  const change = silverRate?.change ?? 0
  const changePercent = silverRate?.changePercent ?? 0
  const updatedAt = silverRate?.updatedAt ?? null

  const overrideCount = permissionsMeta?.overrides ? Object.values(permissionsMeta.overrides).filter((p) => p).length : 0

  const loadNotifications = useCallback(async () => {
    try {
      const [activities, feedRes] = await Promise.all([
        dbApi.getRecentActivities(),
        dbApi.getNotificationFeed().catch(() => null),
      ])
      setNotifications(Array.isArray(activities) ? (activities as any) : (activities as any).items ?? [])
      if (feedRes?.items) {
        setFeed(feedRes.items)
        setUnreadCount(feedRes.counts.alerts)
      } else if (lastSeenAt) {
        const act = Array.isArray(activities) ? (activities as any) : (activities as any).items ?? []
        const newUnread = act.filter((a: any) => a.time && a.time > lastSeenAt).length
        setUnreadCount(newUnread)
      }
    } catch {
      // keep existing notifications
    }
  }, [lastSeenAt])

  useEffect(() => {
    // Defer the first poll out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => {
      void loadNotifications()
    })
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadNotifications()
    }, 15_000)
    return () => window.clearInterval(interval)
  }, [loadNotifications])

  const loadPendingRateRequests = useCallback(async () => {
    if (!isRateApprover) return
    try {
      const res = await dbApi.getSilverRateRequests('pending')
      setPendingRateRequests(res.requests?.length ?? 0)
    } catch {
      // keep the last known count
    }
  }, [isRateApprover])

  useEffect(() => {
    if (!isRateApprover) return
    // Defer the first poll out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => {
      void loadPendingRateRequests()
    })
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadPendingRateRequests()
    }, 60_000)
    return () => window.clearInterval(interval)
  }, [isRateApprover, loadPendingRateRequests])

  const handleNotificationOpen = () => {
    if (notifications.length > 0 && notifications[0].time) {
      setLastSeenAt(notifications[0].time)
    }
    setUnreadCount(0)
  }

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-3 sm:h-16 sm:gap-3 sm:px-4 lg:px-6">
      <button
        onClick={onToggleSidebar}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Toggle sidebar"
      >
        <Menu className="h-5 w-5" />
      </button>

      <button
        onClick={onOpenSearch}
        className="group flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md border border-input bg-background/60 px-3 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-background sm:max-w-md"
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="hidden truncate text-[13px] text-muted-foreground/80 sm:inline">
          Search products, invoices, orders, customers...
        </span>
        <span className="truncate text-[13px] text-muted-foreground/80 sm:hidden">
          Search...
        </span>
        <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground sm:inline">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
        {hasPermission('silver-rate', 'view') ? (
          <Link
            to="/silver-rate"
            className="group hidden items-center gap-3 rounded-lg border border-primary-100 bg-primary-50/60 px-3 py-1.5 transition-colors hover:bg-primary-50 sm:flex"
          >
            <div className="flex flex-col">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-700/70">
                Silver Rate ({silverRate?.purity ?? 92.5})
              </p>
              <p className="text-[13px] font-bold tabular-nums text-primary-800">{rate != null ? `₹${rate.toFixed(2)} / gm` : '—'}</p>
            </div>
            <div className="flex flex-col items-start gap-0.5">
              <Badge variant={change >= 0 ? 'success' : 'danger'} className="gap-0.5 px-1.5 py-0 text-[10px]">
                {change >= 0 ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
                {rate != null ? `${change.toFixed(2)} (${changePercent.toFixed(2)}%)` : '—'}
              </Badge>
              <p className="text-[9.5px] text-muted-foreground">
                {updatedAt ? `Updated ${formatDateTime(updatedAt)}` : 'Loading...'}
              </p>
            </div>
          </Link>
        ) : null}

        {isRateApprover ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/silver-rate"
                  className="relative hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
                  aria-label="Pending silver rate requests"
                >
                  <ShieldCheck className="h-[18px] w-[18px]" />
                  {pendingRateRequests > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
                      {pendingRateRequests > 9 ? '9+' : pendingRateRequests}
                    </span>
                  ) : null}
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                {pendingRateRequests > 0
                  ? `${pendingRateRequests} rate change request${pendingRateRequests > 1 ? 's' : ''} awaiting approval`
                  : 'No rate change requests awaiting approval'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}

        <button
          type="button"
          onClick={() => setThemeState(toggleTheme())}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>

        <DropdownMenu onOpenChange={(open) => { if (open) handleNotificationOpen() }}>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Notifications">
                  <Bell className="h-[18px] w-[18px]" />
                  {unreadCount > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  ) : null}
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Notifications</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <DropdownMenuContent align="end" className="w-80 max-h-96 overflow-y-auto">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>Notifications</span>
              <Link to="/system/activity" className="text-xs font-normal text-muted-foreground hover:text-foreground">View All</Link>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {feed.length > 0 && (
              <div className="px-4 pb-1">
                {feed.slice(0, 8).map((f, i) => (
                  <button
                    key={`f-${i}`}
                    className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
                    onClick={() => navigate(f.href)}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          f.type === 'low-stock' ? 'bg-amber-500' : f.type === 'new-order' ? 'bg-emerald-500' : 'bg-red-500'
                        }`}
                      />
                      <span className="flex-1 truncate text-[13px] font-medium text-foreground">{f.title}</span>
                    </span>
                    {f.detail ? <span className="pl-3.5 text-[11px] text-muted-foreground">{f.detail}</span> : null}
                  </button>
                ))}
                <div className="my-1 flex items-center gap-2 px-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Recent activity</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              </div>
            )}
            {notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">No recent activity</div>
            ) : (
              notifications.slice(0, 5).map((a, i) => (
                <DropdownMenuItem key={a.id ?? i} className="flex flex-col items-start gap-1 py-2">
                  <span className="text-sm font-medium leading-tight">{a.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.actor} — {a.time}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Quick create">
                  <Plus className="h-[18px] w-[18px]" />
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Quick create</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Create new</DropdownMenuLabel>
            {hasPermission('sales', 'create') && (
              <DropdownMenuItem onClick={() => navigate('/sales/orders?new=1')}>
                <ShoppingBag className="h-3.5 w-3.5" /> Sales Order
              </DropdownMenuItem>
            )}
            {hasPermission('sales', 'create') && (
              <DropdownMenuItem onClick={() => navigate('/sales/bookings?new=1')}>
                <FileText className="h-3.5 w-3.5" /> Booking
              </DropdownMenuItem>
            )}
            {hasPermission('inventory', 'create') && (
              <DropdownMenuItem onClick={() => navigate('/inventory/products?new=1')}>
                <Gem className="h-3.5 w-3.5" /> Product
              </DropdownMenuItem>
            )}
            {hasPermission('sales', 'create') && (
              <DropdownMenuItem onClick={() => navigate('/sales/customers?new=1')}>
                <UserPlus className="h-3.5 w-3.5" /> Customer
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link to="/system/settings" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Settings">
                <Settings className="h-[18px] w-[18px]" />
              </Link>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="hidden h-6 w-px bg-border sm:block" />

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 rounded-md p-1 outline-none transition-colors hover:bg-muted">
            <Avatar className="h-8 w-8">
              <AvatarFallback className={currentUser?.avatarColor ?? 'bg-primary-600 text-white'}>
                {currentUser ? initials(currentUser.name) : '?'}
              </AvatarFallback>
            </Avatar>
            <div className="hidden flex-col items-start leading-tight lg:flex">
              <span className="text-[13px] font-semibold text-foreground">{currentUser?.name ?? '—'}</span>
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-3 w-3 text-primary" /> {currentUser?.role ?? '—'}
              </span>
            </div>
            <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground lg:block" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{currentUser?.name} · {currentUser?.role}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="cursor-default text-[11px] text-muted-foreground">
              {overrideCount > 0 ? `${overrideCount} module override(s) applied` : 'Uses role permissions'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => refresh()}>
              <RefreshCcw className="h-3.5 w-3.5" /> Refresh permissions
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Link to="/system/settings" className="flex w-full">
                <Settings className="h-3.5 w-3.5" /> Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout} className="text-red-600 dark:text-red-400 focus:text-red-600 dark:text-red-400">
              <LogOut className="h-3.5 w-3.5" /> Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
