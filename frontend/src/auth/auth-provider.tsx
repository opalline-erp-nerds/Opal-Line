import { useCallback, useEffect, useMemo, useState } from 'react'
import { authApi, dbApi, rbacApi, resetCsrfToken } from '@/lib/api'
import { can } from '@/lib/permissions'
import type { ModulePermission, Permissions, User, UserPermissions } from '@/types'
import { AuthContext } from './auth-context'
import { isConfirmedSessionLoss } from './sessionFailure'
import { markSessionCleared, markSessionEstablished, onSessionLost } from './sessionSignal'

// A cold-starting or briefly unavailable backend should not look like a
// logout. A Render restart, deploy or database failover takes seconds, so the
// probe backs off instead of giving up after one round trip; only a real 401
// clears auth state.
const SESSION_PROBE_RETRY_DELAYS_MS = [500, 1500, 3000, 5000]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [permissions, setPermissions] = useState<Permissions>({})
  const [permissionsMeta, setPermissionsMeta] = useState<UserPermissions | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [sessionUnavailable, setSessionUnavailable] = useState(false)

  const clearSessionState = useCallback(() => {
    setCurrentUser(null)
    setPermissions({})
    setPermissionsMeta(null)
    setSessionUnavailable(false)
  }, [])

  const load = useCallback(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const me = await authApi.getMe()
        // The probe is the one call that proves the cookie still maps to a live
        // session. Mark it immediately, so anything started before it may 401
        // without clearing the state this probe just confirmed.
        markSessionEstablished()
        const [allUsers, meta] = await Promise.all([
          dbApi.getUsers().catch((err) => { console.warn('Failed to load users:', err); return [] as User[] }),
          rbacApi.getUserPermissions(me.id).catch((err) => { console.warn('Failed to load permissions:', err); return null }),
        ])
        setUsers(allUsers)
        setCurrentUser(me)
        setPermissionsMeta(meta)
        setSessionUnavailable(false)
        if (meta?.effective) {
          setPermissions(meta.effective)
        } else if (me.role === 'Super Admin') {
          setPermissions({ '*': { view: true, create: true, edit: true, delete: true } })
        } else {
          setPermissions(meta?.effective ?? {})
        }
        return
      } catch (err) {
        if (isConfirmedSessionLoss(err)) {
          markSessionCleared()
          resetCsrfToken()
          clearSessionState()
          return
        }
        if (attempt < SESSION_PROBE_RETRY_DELAYS_MS.length) {
          await delay(SESSION_PROBE_RETRY_DELAYS_MS[attempt])
          continue
        }
        // Transient failure: keep whatever session state we already have.
        // Clearing it here was signing active users out on a network blip.
        console.warn('Session check failed; keeping the current session:', err)
        // With no cached user (a reload) RequireAuth would otherwise bounce to
        // /login even though the cookie is still valid; flag the outage so it
        // can offer a reconnect screen instead of a login form.
        setSessionUnavailable(true)
        return
      }
    }
  }, [clearSessionState])

  const login = useCallback(
    async (username: string, password: string) => {
      const result = await authApi.login(username, password)
      // The login response already proves the session. Seed the user before
      // the follow-up probe so a transient failure there cannot bounce the
      // freshly signed-in user back to /login.
      markSessionEstablished()
      setSessionUnavailable(false)
      setCurrentUser(result.user)
      setPermissions(result.permissions ?? {})
      await load()
    },
    [load],
  )

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {})
    markSessionCleared()
    resetCsrfToken()
    clearSessionState()
  }, [clearSessionState])

  const refresh = useCallback(async () => {
    await load()
  }, [load])

  // A 401 from anywhere else in the app (page load, poll, save) funnels
  // through the same signal, so the router performs one clean transition to
  // /login instead of every request forcing its own full page reload.
  useEffect(
    () =>
      onSessionLost(() => {
        resetCsrfToken()
        clearSessionState()
      }),
    [clearSessionState],
  )

  useEffect(() => {
    // Kick the session probe off after the effect body (react/set-state-in-effect).
    // load() handles its own retries and never rejects for a transient outage,
    // so there is no logout() in this path.
    queueMicrotask(() => {
      void load().finally(() => setLoading(false))
    })
  }, [load])

  const hasPermission = useCallback(
    (moduleKey: string, action: keyof ModulePermission) => can(permissions, moduleKey, action),
    [permissions],
  )

  const value = useMemo(
    () => ({
      currentUser,
      permissions,
      permissionsMeta,
      users,
      loading,
      sessionUnavailable,
      login,
      logout,
      hasPermission,
      refresh,
    }),
    [currentUser, permissions, permissionsMeta, users, loading, sessionUnavailable, login, logout, hasPermission, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
