import { useCallback, useEffect, useMemo, useState } from 'react'
import { authApi, dbApi, rbacApi, resetCsrfToken } from '@/lib/api'
import { can } from '@/lib/permissions'
import type { ModulePermission, Permissions, User, UserPermissions } from '@/types'
import { AuthContext } from './auth-context'
import { isConfirmedSessionLoss } from './sessionFailure'

// A cold-starting or briefly unavailable backend should not look like a
// logout. Retry the probe twice before giving up; only a real 401 clears state.
const SESSION_PROBE_RETRIES = 2
const SESSION_PROBE_RETRY_DELAY_MS = 400

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [permissions, setPermissions] = useState<Permissions>({})
  const [permissionsMeta, setPermissionsMeta] = useState<UserPermissions | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    for (let attempt = 0; attempt <= SESSION_PROBE_RETRIES; attempt++) {
      try {
        const me = await authApi.getMe()
        const [allUsers, meta] = await Promise.all([
          dbApi.getUsers().catch((err) => { console.warn('Failed to load users:', err); return [] as User[] }),
          rbacApi.getUserPermissions(me.id).catch((err) => { console.warn('Failed to load permissions:', err); return null }),
        ])
        setUsers(allUsers)
        setCurrentUser(me)
        setPermissionsMeta(meta)
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
          setCurrentUser(null)
          setPermissions({})
          setPermissionsMeta(null)
          return
        }
        if (attempt < SESSION_PROBE_RETRIES) {
          await delay(SESSION_PROBE_RETRY_DELAY_MS * (attempt + 1))
          continue
        }
        // Transient failure: keep whatever session state we already have.
        // Clearing it here was signing active users out on a network blip.
        console.warn('Session check failed; keeping the current session:', err)
        return
      }
    }
  }, [])

  const login = useCallback(
    async (username: string, password: string) => {
      const result = await authApi.login(username, password)
      // The login response already proves the session. Seed the user before
      // the follow-up probe so a transient failure there cannot bounce the
      // freshly signed-in user back to /login.
      setCurrentUser(result.user)
      setPermissions(result.permissions ?? {})
      await load()
    },
    [load],
  )

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {})
    resetCsrfToken()
    setCurrentUser(null)
    setPermissions({})
    setPermissionsMeta(null)
  }, [])

  const refresh = useCallback(async () => {
    await load()
  }, [load])

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
    () => ({ currentUser, permissions, permissionsMeta, users, loading, login, logout, hasPermission, refresh }),
    [currentUser, permissions, permissionsMeta, users, loading, login, logout, hasPermission, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
