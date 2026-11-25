import { useEffect, useState, useCallback } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Sidebar } from './sidebar'
import { Header } from './header'
import { SearchCommand } from './search-command'
import { ShortcutsHelp } from './shortcuts-help'
import { UpdateBanner } from './update-banner'
import { SHORTCUT_PATHS } from '@/lib/shortcuts'
import { useMediaQuery } from '@/hooks/use-media-query'

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  // Tablets use the overlay drawer too; a permanent 240px sidebar leaves too
  // little room for the dashboard grids below 1024px.
  const isMobile = useMediaQuery('(max-width: 1023px)')

  const toggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileOpen((v) => !v)
    } else {
      setCollapsed((v) => !v)
    }
  }, [isMobile])

  const closeMobileSidebar = useCallback(() => {
    setMobileOpen(false)
  }, [])

  useEffect(() => {
    let gPending = false
    let gTimer: number | undefined
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
        return
      }
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.tagName === 'SELECT')
      if (e.key === '?' && !typing) {
        e.preventDefault()
        setHelpOpen((v) => !v)
        return
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      if (gPending) {
        const path = SHORTCUT_PATHS[e.key.toLowerCase()]
        gPending = false
        window.clearTimeout(gTimer)
        if (path) {
          e.preventDefault()
          navigate(path)
        }
        return
      }
      if (e.key.toLowerCase() === 'g') {
        gPending = true
        gTimer = window.setTimeout(() => { gPending = false }, 1200)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(gTimer)
    }
  }, [navigate])

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [location.pathname])

  useEffect(() => {
    if (!isMobile) return
    // Defer the collapse sync out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => setCollapsed(false))
  }, [isMobile])

  return (
    <div className="app-shell flex h-screen w-screen overflow-hidden bg-background">
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 transition-opacity"
          onClick={closeMobileSidebar}
        />
      )}

      <div
        className={`app-sidebar-wrap
          ${isMobile ? 'fixed inset-y-0 left-0 z-50' : 'relative'}
          ${isMobile && !mobileOpen ? '-translate-x-full' : 'translate-x-0'}
          transition-transform duration-200 ease-in-out
        `}
      >
        <Sidebar collapsed={isMobile ? false : collapsed} onNavigate={closeMobileSidebar} />
      </div>

      <div className="app-content-col flex min-w-0 flex-1 flex-col">
        <div className="app-header-wrap">
          <Header onToggleSidebar={toggleSidebar} onOpenSearch={() => setSearchOpen(true)} />
          <UpdateBanner />
        </div>
        <main className="app-main flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  )
}
