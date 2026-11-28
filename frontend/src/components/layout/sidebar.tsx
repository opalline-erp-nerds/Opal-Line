import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ChevronRight, LogOut, Gem, ShieldCheck } from 'lucide-react'
import { navSections } from '@/config/navigation'
import { moduleForPath } from '@/lib/permissions'
import { useAuth } from '@/auth/auth-context'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface SidebarProps {
  collapsed: boolean
  onNavigate?: () => void
}

export function Sidebar({ collapsed, onNavigate }: SidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { hasPermission, currentUser, logout } = useAuth()
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navSections.map((s) => [s.label, true])),
  )

  const visibleSections = useMemo(
    () =>
      navSections
        .map((s) => ({
          ...s,
          items: s.items.filter((i) => hasPermission(moduleForPath(i.path), 'view')),
        }))
        .filter((s) => s.items.length > 0),
    [hasPermission],
  )

  const isPathActive = useCallback(
    (path: string) =>
      path === '/'
        ? location.pathname === '/'
        : location.pathname === path || location.pathname.startsWith(`${path}/`),
    [location.pathname],
  )

  useEffect(() => {
    const section = visibleSections.find((s) =>
      s.items.some((i) => i.path !== '/' && isPathActive(i.path)),
    )
    if (!section) return
    // Defer the expand out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => setExpanded((prev) => ({ ...prev, [section.label]: true })))
  }, [location.pathname, visibleSections, isPathActive])

  const isActive = isPathActive

  const toggleSection = (label: string) => {
    if (collapsed) return
    setExpanded((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-[64px]' : 'w-[240px]',
      )}
    >
      <div className={cn('flex items-center gap-3 px-4 pt-5', collapsed && 'justify-center px-0')}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-primary text-primary-foreground shadow-sm shadow-primary-600/20 ring-1 ring-champagne/30">
          <Gem className="h-5 w-5 text-primary-foreground" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="font-serif text-[19px] font-semibold leading-none tracking-[0.12em] text-foreground">
              OPAL LINE
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="h-px w-4 shrink-0 bg-champagne/70" />
              <p className="truncate text-[9px] font-medium uppercase tracking-[0.16em] text-sidebar-muted">
                Jewellery Billing ERP
              </p>
            </div>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="mx-4 mt-4 rounded-2xl border border-sidebar-border bg-card px-3.5 py-2.5">
          <p className="text-[11px] font-medium text-sidebar-foreground/70">92.5 Sterling Silver</p>
          <p className="mt-0.5 text-[11px] text-primary-600">Ecommerce · Shopify Connected</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sidebar-scroll">
        <TooltipProvider delayDuration={300}>
          {visibleSections.map((section) => {
            const isOpen = expanded[section.label]
            return (
              <div key={section.label} className="mb-5">
                <button
                  onClick={() => toggleSection(section.label)}
                  className={cn(
                    'flex w-full items-center px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted/90 transition-colors hover:text-primary-700',
                    collapsed && 'justify-center',
                  )}
                >
                  {!collapsed && (
                    <>
                      <span>{section.label}</span>
                      <ChevronRight
                        className={cn(
                          'ml-auto h-3 w-3 transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                    </>
                  )}
                </button>
                {isOpen && (
                  <nav className={cn('space-y-1', collapsed && 'space-y-1.5')}>
                    {section.items.map((item) => {
                      const active = isActive(item.path)
                      const content = (
                        <Link
                          to={item.path}
                          onClick={onNavigate}
                          className={cn(
                            'group relative flex items-center gap-3 rounded-full px-3.5 py-2.5 text-[14px] font-medium transition-all duration-150',
                            collapsed && 'justify-center px-0 py-2.5',
                            active
                              ? 'bg-sidebar-active text-sidebar-active-foreground shadow-sm shadow-primary-600/20'
                              : 'text-sidebar-foreground/80 hover:bg-sidebar-hover hover:text-primary-700',
                          )}
                        >
                          <item.icon
                            className={cn(
                              'h-[18px] w-[18px] shrink-0 transition-colors',
                              active
                                ? 'text-sidebar-active-foreground'
                                : 'text-sidebar-muted group-hover:text-primary-700',
                            )}
                          />
                          {!collapsed && <span className="truncate">{item.title}</span>}
                          {!collapsed && item.badge && (
                            <span className="ml-auto rounded-full bg-primary-600 px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                              {item.badge}
                            </span>
                          )}
                        </Link>
                      )
                      return collapsed ? (
                        <Tooltip key={item.path}>
                          <TooltipTrigger asChild>{content}</TooltipTrigger>
                          <TooltipContent side="right">{item.title}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <div key={item.path}>{content}</div>
                      )
                    })}
                  </nav>
                )}
              </div>
            )
          })}
        </TooltipProvider>
      </div>

      <div className="border-t border-sidebar-border p-4">
        <div className="mb-2 flex items-center gap-2.5 rounded-2xl border border-sidebar-border bg-card px-3 py-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
            {currentUser ? currentUser.name.split(' ').map((p) => p[0]).join('').slice(0, 2) : '?'}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[12px] font-semibold text-sidebar-foreground">{currentUser?.name ?? '—'}</p>
              <p className="flex items-center gap-1 truncate text-[10.5px] text-sidebar-muted">
                <ShieldCheck className="h-3 w-3 shrink-0" /> {currentUser?.role ?? '—'}
              </p>
            </div>
          )}
        </div>
        <button
          onClick={handleLogout}
          className={cn(
            'flex w-full items-center gap-3 rounded-full px-3.5 py-2.5 text-[14px] font-medium text-sidebar-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400',
            collapsed && 'justify-center px-0',
          )}
        >
          <LogOut className="h-[18px] w-[18px] shrink-0" />
          {!collapsed && <span>Logout</span>}
        </button>
      </div>
      <style>{`
        .sidebar-scroll::-webkit-scrollbar { width: 6px; }
        .sidebar-scroll::-webkit-scrollbar-thumb { background: hsl(var(--sidebar-border)); border: 0; }
        .sidebar-scroll::-webkit-scrollbar-thumb:hover { background: hsl(var(--primary-200)); }
      `}</style>
    </aside>
  )
}
