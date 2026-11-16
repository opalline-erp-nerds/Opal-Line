import { createContext, useContext } from 'react'
import type { ModulePermission, Permissions, User, UserPermissions } from '@/types'

export interface AuthContextValue {
  currentUser: User | null
  permissions: Permissions
  permissionsMeta: UserPermissions | null
  users: User[]
  loading: boolean
  /** True when the last session probe failed for a transient reason. */
  sessionUnavailable: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  hasPermission: (moduleKey: string, action: keyof ModulePermission) => boolean
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
