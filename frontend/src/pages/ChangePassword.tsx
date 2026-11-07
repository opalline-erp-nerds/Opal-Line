import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authApi } from '@/lib/api'
import { useAuth } from '@/auth/auth-context'
import { AuthLayout, authInputClass, authLabelClass } from '@/components/layout/auth-layout'

const RULES = [
  { test: (v: string) => v.length >= 8, label: 'At least 8 characters' },
  { test: (v: string) => /[A-Z]/.test(v), label: 'One uppercase letter' },
  { test: (v: string) => /[a-z]/.test(v), label: 'One lowercase letter' },
  { test: (v: string) => /[0-9]/.test(v), label: 'One number' },
  { test: (v: string) => /[^A-Za-z0-9]/.test(v), label: 'One special character' },
]

export default function ChangePasswordPage() {
  const { currentUser, refresh, logout } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const unmet = RULES.filter((r) => !r.test(newPassword))
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword
  const ready = currentPassword.length > 0 && unmet.length === 0 && !mismatch

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await authApi.changePassword(currentPassword, newPassword)
      // Re-read the profile so requirePasswordChange clears before the app
      // shell (and the rest of the API) becomes reachable again.
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-white sm:text-3xl">
          Choose a new password
        </h1>
        <p className="mt-2 text-sm text-[#cdc0ad]">
          {currentUser?.username ? `Signed in as ${currentUser.username}. ` : ''}
          You must set a new password before using Opal Line.
        </p>
      </div>

      <form onSubmit={submit} className="mt-7 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="currentPassword" className={authLabelClass}>
            Current password
          </Label>
          <Input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className={authInputClass}
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="newPassword" className={authLabelClass}>
            New password
          </Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className={authInputClass}
          />
          <ul className="grid grid-cols-1 gap-0.5 text-xs text-[#bdae99] sm:grid-cols-2">
            {RULES.map((r) => {
              const ok = r.test(newPassword)
              return (
                <li key={r.label} className={ok ? 'text-[#8fd6a8]' : undefined}>
                  {ok ? '✓' : '•'} {r.label}
                </li>
              )
            })}
          </ul>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword" className={authLabelClass}>
            Confirm new password
          </Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={authInputClass}
          />
          {mismatch && <p className="text-xs text-[#ffc3b8]">Passwords do not match.</p>}
        </div>

        {error && (
          <p role="alert" className="text-sm text-[#ffc3b8]">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            type="submit"
            disabled={!ready || busy}
            className="h-11 flex-1 rounded-lg bg-gold text-[15px] font-semibold text-gold-foreground shadow-lg shadow-black/30 hover:bg-gold/90 focus-visible:ring-2 focus-visible:ring-[#e6c16f] focus-visible:ring-offset-2 focus-visible:ring-offset-[#15110d]"
          >
            <KeyRound className="h-4 w-4" />
            {busy ? 'Saving…' : 'Set new password'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={logout}
            className="h-11 rounded-lg px-4 text-[#e8dcc8] hover:bg-white/10 hover:text-white"
          >
            Sign out
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
