import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2, LogIn } from 'lucide-react'
import { useAuth } from '@/auth/auth-context'
import { ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthLayout, authInputClass, authLabelClass } from '@/components/layout/auth-layout'

function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof TypeError) return 'Cannot reach the server. Check your connection and try again.'
  return err instanceof Error && err.message ? err.message : 'Invalid username or password'
}

export default function LoginPage() {
  const navigate = useNavigate()
  const { login, currentUser, loading: authLoading } = useAuth()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (currentUser) navigate('/', { replace: true })
  }, [currentUser, navigate])

  const signIn = async () => {
    if (!identifier.trim() || !password || signingIn) return
    setSigningIn(true)
    setError('')
    try {
      await login(identifier.trim(), password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(loginErrorMessage(err))
      setSigningIn(false)
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-sidebar">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <AuthLayout>
      <div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground sm:text-[28px]">Welcome back</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">Sign in to your account</p>
      </div>

      <form
        className="mt-7 space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void signIn()
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="username" className={authLabelClass}>
            Username or email
          </Label>
          <Input
            id="username"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className={authInputClass}
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className={authLabelClass}>
            Password
          </Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${authInputClass} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          className="h-11 w-full rounded-lg bg-primary text-[15px] font-semibold text-primary-foreground shadow-sm hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-2"
          disabled={!identifier.trim() || !password || signingIn}
        >
          {signingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          {signingIn ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthLayout>
  )
}
