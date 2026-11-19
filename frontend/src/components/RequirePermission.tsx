import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ShieldAlert, WifiOff } from 'lucide-react'
import { useAuth } from '@/auth/auth-context'
import { MODULES, moduleForPath, pathForModule } from '@/lib/permissions'
import { navSections } from '@/config/navigation'
import { Button } from '@/components/ui/button'
import ChangePasswordPage from '@/pages/ChangePassword'

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { currentUser, loading, sessionUnavailable, refresh } = useAuth()
  const location = useLocation()

  useEffect(() => {
    if (!loading && !currentUser) {
      window.scrollTo({ top: 0 })
    }
  }, [loading, currentUser])

  if (loading) {
    return (
      <div className="flex h-full min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        Loading workspace...
      </div>
    )
  }
  // The probe failed for a transient reason and there is no cached user yet:
  // show a reconnect screen instead of the login form. Bouncing here is what
  // turned a server hiccup on reload into "I was logged out".
  if (!currentUser && sessionUnavailable) {
    return <SessionUnavailable onRetry={refresh} />
  }
  if (!currentUser) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  // The server refuses every other endpoint until the initial password is
  // rotated, so show that screen instead of an app that 403s on every call.
  if (currentUser.requirePasswordChange) {
    return <ChangePasswordPage />
  }
  return <>{children}</>
}

export function RequireModule({ module, children }: { module: string; children: React.ReactNode }) {
  const { hasPermission } = useAuth()
  const location = useLocation()
  if (hasPermission(module, 'view')) {
    return <>{children}</>
  }
  // Module not granted. Send the user to the first page they CAN see — a real
  // nav destination (there are no bare '/sales' style routes to land on) — but
  // when the super admin hasn't turned anything on yet, render a clear
  // waiting screen instead of redirect-looping between '/' (the dashboard,
  // itself guarded) and every guarded route.
  const first = MODULES.find((m) => hasPermission(m.key, 'view'))
  if (!first) return <NoModulesAccess />
  const target =
    navSections
      .flatMap((s) => s.items)
      .find((i) => hasPermission(moduleForPath(i.path), 'view'))?.path ?? pathForModule(first.key)
  if (target === location.pathname) return <NoModulesAccess />
  return <Navigate to={target} replace />
}

/** Shown when a user has no modules enabled at all — no redirect target exists. */
function NoModulesAccess() {
  const { currentUser, logout } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <ShieldAlert className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">No modules enabled yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {currentUser ? `${currentUser.name}, no` : 'No'} modules have been turned on for this account yet.
          Ask your super admin to enable the modules you need from{' '}
          <span className="font-medium text-foreground">Users &amp; Roles</span> — they will appear in the
          sidebar as soon as they are switched on.
        </p>
        <Button
          variant="outline"
          className="mt-5"
          onClick={() => {
            logout()
            navigate('/login', { replace: true })
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  )
}

/** Shown when the session probe could not reach the backend.
 *
 * A reload or a Render restart must not present the login form while the
 * session cookie is still valid — that is the experience users reported as
 * "being logged out". The cookie is untouched here; the user retries.
 */
function SessionUnavailable({ onRetry }: { onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false)
  const retry = async () => {
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <WifiOff className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Can&apos;t reach the server</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your session is still signed in — this is a connection problem, not a logout. Retry once the server is reachable.
        </p>
        <Button className="mt-5" onClick={retry} disabled={retrying}>
          {retrying ? 'Reconnecting…' : 'Retry'}
        </Button>
      </div>
    </div>
  )
}
