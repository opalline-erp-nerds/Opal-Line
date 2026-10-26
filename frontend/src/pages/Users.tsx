import { toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import { Clock, Eye, EyeOff, KeyRound, Loader2, Pencil, PlayCircle, Plus, Search, Shield, ShieldCheck, Trash2, UserCog, UserRoundPen, Users } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable } from '@/components/ui/data-table'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi, rbacApi } from '@/lib/api'
import { ACTIONS, MODULES, emptyPermissions } from '@/lib/permissions'
import { useAuth } from '@/auth/auth-context'
import type { Permissions, Role, User, UserPermissions } from '@/types'
import { formatDateTime } from '@/lib/format'
import { initials } from '@/lib/utils'

const statusBadge: Record<User['status'], { label: string; variant: 'success' | 'muted' | 'info' }> = {
  active: { label: 'Active', variant: 'success' },
  inactive: { label: 'Inactive', variant: 'muted' },
  invited: { label: 'Invited', variant: 'info' },
}

export default function UsersPage() {
  const { hasPermission, refresh, currentUser } = useAuth()
  const canEdit = hasPermission('system', 'edit')
  // Module grants are the super admin's call — the backend enforces this
  // (requireSuperAdmin); the controls are hidden from other editors so they
  // are not clickable-then-403.
  const isSuperAdmin = currentUser?.role === 'Super Admin'
  // Deleting a user or a custom role is a distinct server-side permission
  // (requirePermission('system', 'delete')), so it needs its own gate —
  // otherwise the button is clickable and always fails with 403.
  const canDelete = hasPermission('system', 'delete')

  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [inviteOpen, setInviteOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [permsOpen, setPermsOpen] = useState(false)
  const [roleDialogOpen, setRoleDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [inviteForm, setInviteForm] = useState({ name: '', email: '', username: '', role: '', password: '', showPassword: false })
  const [editUser, setEditUser] = useState<User | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [permsUser, setPermsUser] = useState<User | null>(null)
  const [permsData, setPermsData] = useState<UserPermissions | null>(null)
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [roleDraft, setRoleDraft] = useState<{ name: string; description: string; permissions: Permissions }>({
    name: '',
    description: '',
    permissions: emptyPermissions(),
  })
  // Form snapshots as-of-open, for the unsaved-changes close guards.
  const [inviteBaseline, setInviteBaseline] = useState('')
  const [editBaseline, setEditBaseline] = useState('')
  const [permsBaseline, setPermsBaseline] = useState('')
  const [roleBaseline, setRoleBaseline] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([dbApi.getUsers(), rbacApi.getRoles()])
      .then(([u, r]) => {
        setUsers(u)
        setRoles(r)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  const roleNames = useMemo(() => roles.map((r) => r.name), [roles])

  const openInvite = () => {
    const next = { name: '', email: '', username: '', role: roleNames[0] ?? 'Manager', password: '', showPassword: false }
    setInviteForm(next)
    setInviteBaseline(JSON.stringify({ ...next, showPassword: undefined }))
    setError('')
    setInviteOpen(true)
  }

  const submitInvite = async () => {
    if (!inviteForm.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteForm.email.trim())) {
      setError('Enter a valid name and email')
      return
    }
    if (!inviteForm.username.trim()) {
      setError('Enter a username (login id)')
      return
    }
    if (!inviteForm.password || inviteForm.password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setSaving(true)
    setError('')
    try {
      await dbApi.create('users', {
        name: inviteForm.name.trim(),
        email: inviteForm.email.trim(),
        username: inviteForm.username.trim().toLowerCase(),
        role: inviteForm.role,
        password: inviteForm.password,
        status: 'active',
        lastLogin: null,
        avatarColor: 'bg-primary-600',
      })
      setInviteOpen(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to invite user')
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (user: User) => {
    setEditUser(user)
    setEditBaseline(JSON.stringify(user))
    setNewPassword('')
    setShowNewPassword(false)
    setError('')
    setEditOpen(true)
  }

  const submitEdit = async () => {
    if (!editUser) return
    if (!editUser.username.trim()) {
      setError('Username (login id) is required')
      return
    }
    setSaving(true)
    setError('')
    try {
      const { id, permissions: _permissions, ...rest } = editUser
      const patch: Record<string, unknown> = { ...rest }
      if (newPassword) {
        if (newPassword.length < 8) {
          setError('Password must be at least 8 characters')
          setSaving(false)
          return
        }
        patch.password = newPassword
      }
      await dbApi.update('users', id, patch)
      setEditOpen(false)
      load()
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update user')
    } finally {
      setSaving(false)
    }
  }

  const setStatus = useCallback(async (user: User, status: User['status']) => {
    try {
      await dbApi.update('users', user.id, { status })
      load()
    } catch {
      toast.error('Failed to update user status')
    }
  }, [load])

  const openResetPassword = (user: User) => {
    setResetUser(user)
    setResetPassword('')
    setShowResetPassword(false)
    setError('')
    setEditOpen(false)
    setPermsOpen(false)
    setInviteOpen(false)
    setRoleDialogOpen(false)
  }

  const submitResetPassword = async () => {
    if (!resetUser) return
    if (!resetPassword || resetPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setSaving(true)
    setError('')
    try {
      await dbApi.update('users', resetUser.id, { password: resetPassword })
      setResetUser(null)
      setResetPassword('')
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set password')
    } finally {
      setSaving(false)
    }
  }

  const openPerms = async (user: User) => {
    setPermsUser(user)
    setPermsData(null)
    setPermsBaseline('')
    setPermsOpen(true)
    try {
      const meta = await rbacApi.getUserPermissions(user.id)
      setPermsData(meta)
      setPermsBaseline(JSON.stringify(meta.overrides))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load permissions')
    }
  }

  const savePerms = async () => {
    if (!permsUser || !permsData) return
    setSaving(true)
    setError('')
    try {
      const meta = await rbacApi.setUserPermissions(permsUser.id, permsData.overrides)
      setPermsData(meta)
      setPermsOpen(false)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save permissions')
    } finally {
      setSaving(false)
    }
  }

  const openRoleDialog = (role?: Role) => {
    const next = {
      name: role?.name ?? '',
      description: role?.description ?? '',
      permissions: role?.permissions ? { ...role.permissions } : emptyPermissions(),
    }
    setEditingRole(role ?? null)
    setRoleDraft(next)
    setRoleBaseline(JSON.stringify(next))
    setError('')
    setRoleDialogOpen(true)
  }

  const submitRole = async () => {
    if (!roleDraft.name.trim()) {
      setError('Role name is required')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (editingRole) {
        await rbacApi.updateRole(editingRole.id, {
          name: roleDraft.name.trim(),
          description: roleDraft.description.trim(),
          permissions: roleDraft.permissions,
        })
      } else {
        await rbacApi.createRole({
          name: roleDraft.name.trim(),
          description: roleDraft.description.trim(),
          permissions: roleDraft.permissions,
        })
      }
      setRoleDialogOpen(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save role')
    } finally {
      setSaving(false)
    }
  }

  const deleteRole = async (role: Role) => {
    try {
      await rbacApi.removeRole(role.id)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete role')
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return users.filter((u) => {
      const matchQ = !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || u.role.toLowerCase().includes(q)
      const matchRole = !roleFilter || u.role === roleFilter
      const matchStatus = !statusFilter || u.status === statusFilter
      return matchQ && matchRole && matchStatus
    })
  }, [users, query, roleFilter, statusFilter])

  const activeCount = users.filter((u) => u.status === 'active').length
  const usersByRole = useMemo(() => {
    const m = new Map<string, number>()
    for (const u of users) m.set(u.role, (m.get(u.role) ?? 0) + 1)
    return m
  }, [users])

  const columns = useMemo<ColumnDef<User>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'User',
        meta: { headerClassName: 'min-w-[220px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <Avatar className="h-9 w-9">
              <AvatarFallback className={row.original.avatarColor}>{initials(row.original.name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium text-foreground">{row.original.name}</p>
              <p className="text-[11px] text-muted-foreground">@{row.original.username} · {row.original.email}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'role',
        header: 'Role',
        cell: ({ row }) => (
          <Badge variant="muted">
            <ShieldCheck className="h-3 w-3" /> {row.original.role}
          </Badge>
        ),
      },
      {
        accessorKey: 'lastLogin',
        header: 'Last Login',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> {formatDateTime(row.original.lastLogin)}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusBadge[row.original.status] ?? { label: row.original.status ?? "—", variant: "muted" as const }
          return <Badge variant={s.variant} dot>{s.label}</Badge>
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const, headerClassName: 'w-10' },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" disabled={!canEdit} onClick={() => openEdit(row.original)}>
                    <UserRoundPen className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit user</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" disabled={!canEdit} onClick={() => openResetPassword(row.original)}>
                    <KeyRound className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Set password</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" disabled={!canEdit || !isSuperAdmin} onClick={() => openPerms(row.original)}>
                    <Shield className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isSuperAdmin ? 'Manage permissions' : 'Super admin only'}</TooltipContent>
              </Tooltip>
              {row.original.status === 'active' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" disabled={!canEdit} onClick={() => setStatus(row.original, 'inactive')}>
                      <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Deactivate user</TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" disabled={!canEdit} onClick={() => setStatus(row.original, 'active')}>
                      <PlayCircle className="h-3.5 w-3.5 text-success-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Activate user</TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [canEdit, isSuperAdmin, setStatus],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Users & Roles"
        subtitle="Manage role-based access to modules. Fine-grained permissions are configured per user."
        actions={
          <Button size="sm" onClick={openInvite} disabled={!canEdit}>
            <Plus className="h-4 w-4" /> Invite User
          </Button>
        }
      />

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">
            <Users className="h-3.5 w-3.5" /> Users
          </TabsTrigger>
          <TabsTrigger value="roles">
            <Shield className="h-3.5 w-3.5" /> Roles
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 md:grid-cols-3">
            <MiniCard icon={Users} label="Total Users" value={String(users.length)} sub="All accounts" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
            <MiniCard icon={UserCog} label="Active" value={String(activeCount)} sub="Currently active" tint="bg-success-50 text-success-700" />
            <MiniCard icon={Shield} label="Roles" value={String(roles.length)} sub="Permission profiles" tint="bg-info-50 text-info-700" />
          </div>

          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search name, email, role..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Select
                  options={[
                    { value: '', label: 'All Roles' },
                    ...roleNames.map((r) => ({ value: r, label: r })),
                  ]}
                  value={roleFilter}
                  onValueChange={setRoleFilter}
                  className="w-[170px]"
                />
                <Select
                  options={[
                    { value: '', label: 'All Status' },
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive' },
                    { value: 'invited', label: 'Invited' },
                  ]}
                  value={statusFilter}
                  onValueChange={setStatusFilter}
                  className="w-[140px]"
                />
                <div className="ml-auto text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{filtered.length}</span> of {users.length} users
                </div>
              </div>

              <DataTable
                columns={columns}
                data={filtered}
                loading={loading}
                emptyMessage="No users found"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="roles">
          <div className="flex items-center justify-end pb-1">
            <Button size="sm" variant="outline" onClick={() => openRoleDialog()} disabled={!canEdit || !isSuperAdmin}>
              <Plus className="h-4 w-4" /> New Role
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {roles.map((role) => {
              const granted = MODULES.filter((m) => role.permissions[m.key]?.view).length
              return (
                <Card key={role.id} className="flex flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                        <Shield className="h-4.5 w-4.5" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{role.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {usersByRole.get(role.name) ?? 0} user(s)
                        </p>
                      </div>
                    </div>
                    {role.isSystem ? (
                      <Badge variant="info" className="shrink-0">System</Badge>
                    ) : (
                      <Badge variant="muted" className="shrink-0">Custom</Badge>
                    )}
                  </div>
                  <p className="mt-2.5 line-clamp-2 text-[12px] text-muted-foreground">
                    {role.description || 'No description'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant="muted" className="text-[10px]">{granted} modules</Badge>
                    {role.name === 'Super Admin' ? (
                      <Badge variant="success" className="text-[10px]">Full access</Badge>
                    ) : null}
                  </div>
                  <div className="mt-auto flex items-center justify-end gap-2 pt-4">
                    <Button variant="outline" size="sm" disabled={!canEdit || !isSuperAdmin} onClick={() => openRoleDialog(role)}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!canEdit || !isSuperAdmin} onClick={() => openRoleDialog(role)}>
                      <KeyRound className="h-3.5 w-3.5" /> Permissions
                    </Button>
                    {!role.isSystem ? (
                      <Button variant="ghost" size="sm" className="text-red-600 dark:text-red-400 hover:text-red-600 dark:text-red-400" disabled={!canDelete} onClick={() => deleteRole(role)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </Card>
              )
            })}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            System roles cannot be deleted. Permissions are stored per module as View / Add / Edit / Delete. Each user inherits their role
            and can be fine-tuned with personal overrides.
          </p>
        </TabsContent>
      </Tabs>

      <AppDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        size="sm"
        isDirty={inviteOpen && JSON.stringify({ ...inviteForm, showPassword: undefined }) !== inviteBaseline}
        title="Invite User"
        description="Invite a team member to access Opal Line."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button onClick={submitInvite} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Send Invite
            </Button>
          </DialogFooter>
        }
      >
          <div className="grid gap-4">
            <Field label="Full Name">
              <Input
                placeholder="e.g. Rohan Desai"
                value={inviteForm.name}
                onChange={(e) => setInviteForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                placeholder="rohan@opalline.in"
                value={inviteForm.email}
                onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
              />
            </Field>
            <Field label="Username (login id)">
              <Input
                placeholder="e.g. rohan"
                value={inviteForm.username}
                onChange={(e) => setInviteForm((f) => ({ ...f, username: e.target.value }))}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Role">
                <Select
                  options={roleNames.map((r) => ({ value: r, label: r }))}
                  value={inviteForm.role}
                  onValueChange={(v) => setInviteForm((f) => ({ ...f, role: v }))}
                  className="w-full"
                />
              </Field>
              <Field label="Password">
                <div className="relative">
                  <Input
                    type={inviteForm.showPassword ? 'text' : 'password'}
                    placeholder="Min 8 characters"
                    value={inviteForm.password}
                    onChange={(e) => setInviteForm((f) => ({ ...f, password: e.target.value }))}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setInviteForm((f) => ({ ...f, showPassword: !f.showPassword }))}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={inviteForm.showPassword ? 'Hide password' : 'Show password'}
                  >
                    {inviteForm.showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>
            </div>
            {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          </div>
      </AppDialog>

      <AppDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        size="md"
        isDirty={editOpen && (newPassword !== '' || (editUser !== null && JSON.stringify(editUser) !== editBaseline))}
        title="Edit User"
        description={`Update profile and role for ${editUser?.name ?? ''}.`}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save Changes
            </Button>
          </DialogFooter>
        }
      >
          {editUser ? (
            <div className="grid gap-4">
              <Field label="Full Name">
                <Input value={editUser.name} onChange={(e) => setEditUser((u) => (u ? { ...u, name: e.target.value } : u))} />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={editUser.email}
                  onChange={(e) => setEditUser((u) => (u ? { ...u, email: e.target.value } : u))}
                />
              </Field>
              <Field label="Username (login id)">
                <Input
                  value={editUser.username}
                  onChange={(e) => setEditUser((u) => (u ? { ...u, username: e.target.value } : u))}
                />
              </Field>
              <Field label="New password (leave blank to keep current)">
                <div className="relative">
                  <Input
                    type={showNewPassword ? 'text' : 'password'}
                    placeholder="Min 8 characters"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                  >
                    {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>
              <Field label="Role">
                <Select
                  options={roleNames.map((r) => ({ value: r, label: r }))}
                  value={editUser.role}
                  onValueChange={(v) => setEditUser((u) => (u ? { ...u, role: v } : u))}
                  className="w-full"
                />
              </Field>
              <Field label="Status">
                <Select
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive' },
                    { value: 'invited', label: 'Invited' },
                  ]}
                  value={editUser.status}
                  onValueChange={(v) => setEditUser((u) => (u ? { ...u, status: v as User['status'] } : u))}
                  className="w-full"
                />
              </Field>
              {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
            </div>
          ) : null}
      </AppDialog>

      <AppDialog
        open={Boolean(resetUser)}
        onOpenChange={(open) => { if (!open) setResetUser(null) }}
        size="sm"
        isDirty={resetPassword !== ''}
        title="Set Password"
        description={`Set a new login password for ${resetUser?.name ?? ''}.`}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetUser(null)}>Cancel</Button>
            <Button onClick={submitResetPassword} disabled={saving || !resetPassword}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Save Password
            </Button>
          </DialogFooter>
        }
      >
          <div className="grid gap-4">
            <Field label="New password">
              <div className="relative">
                <Input
                  type={showResetPassword ? 'text' : 'password'}
                  placeholder="Min 8 characters"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowResetPassword((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showResetPassword ? 'Hide password' : 'Show password'}
                >
                  {showResetPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          </div>
      </AppDialog>

      <AppDialog
        open={permsOpen}
        onOpenChange={setPermsOpen}
        size="xl"
        isDirty={permsOpen && permsData !== null && JSON.stringify(permsData.overrides) !== permsBaseline}
        title="Manage Permissions"
        description={
          <>
            {permsUser?.name} inherits the <span className="font-medium text-foreground">{permsUser?.role}</span> role.
            Toggle a cell to create a personal override; un-checking role defaults reverts to the role.
          </>
        }
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setPermsOpen(false)}>Cancel</Button>
            <Button onClick={savePerms} disabled={saving || !permsData}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save Permissions
            </Button>
          </DialogFooter>
        }
      >
          {permsData ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <span className="text-xs text-muted-foreground">
                  Role: <span className="font-semibold text-foreground">{permsData.role}</span>
                  {permsData.overrides ? ' · has personal overrides' : ' · uses role defaults'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setPermsData((p) => (p ? { ...p, overrides: null } : p))}
                >
                  Reset to role defaults
                </Button>
              </div>
              <PermissionGrid
                permissions={permsData.overrides ?? emptyPermissions()}
                onChange={(next) => setPermsData((p) => (p ? { ...p, overrides: next } : p))}
              />
              <div className="rounded-md border bg-success-50 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-success-700">Effective permissions</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {MODULES.filter((m) => permsData.effective[m.key]?.view).map((m) => (
                    <Badge key={m.key} variant="success" className="text-[10px]">{m.label}</Badge>
                  ))}
                  {MODULES.every((m) => !permsData.effective[m.key]?.view) ? (
                    <span className="text-xs text-muted-foreground">No module access</span>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      </AppDialog>

      <AppDialog
        open={roleDialogOpen}
        onOpenChange={setRoleDialogOpen}
        size="lg"
        isDirty={roleDialogOpen && JSON.stringify(roleDraft) !== roleBaseline}
        title={editingRole ? `Edit Role — ${editingRole.name}` : 'New Role'}
        description="Configure module access for this role. Users assigned to the role inherit these permissions."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitRole} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editingRole ? 'Save Role' : 'Create Role'}
            </Button>
          </DialogFooter>
        }
      >
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Role Name">
                <Input
                  placeholder="e.g. Operations"
                  value={roleDraft.name}
                  disabled={editingRole?.isSystem}
                  onChange={(e) => setRoleDraft((f) => ({ ...f, name: e.target.value }))}
                />
              </Field>
              <Field label="Description">
                <Input
                  placeholder="What does this role cover?"
                  value={roleDraft.description}
                  onChange={(e) => setRoleDraft((f) => ({ ...f, description: e.target.value }))}
                />
              </Field>
            </div>
            <PermissionGrid
              permissions={roleDraft.permissions}
              onChange={(next) => setRoleDraft((f) => ({ ...f, permissions: next }))}
            />
            {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          </div>
      </AppDialog>
    </div>
  )
}

function PermissionGrid({
  permissions,
  onChange,
}: {
  permissions: Permissions
  onChange: (next: Permissions) => void
}) {
  const toggle = (moduleKey: string, action: keyof Permissions[string]) => {
    const next = { ...permissions }
    const cell = { ...(next[moduleKey] ?? { view: false, create: false, edit: false, delete: false }) }
    cell[action] = !cell[action]
    next[moduleKey] = cell
    onChange(next)
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-muted/60 text-left text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-semibold">Module</th>
            {ACTIONS.map((a) => (
              <th key={a.key} className="px-2 py-2 text-center font-semibold">{a.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MODULES.map((m, i) => (
            <tr key={m.key} className={i % 2 ? 'bg-muted/20' : ''}>
              <td className="px-3 py-2">
                <p className="text-[13px] font-medium text-foreground">{m.label}</p>
                <p className="text-[11px] text-muted-foreground">{m.description}</p>
              </td>
              {ACTIONS.map((a) => (
                <td key={a.key} className="px-2 py-2 text-center">
                  <div className="flex items-center justify-center">
                    <span className="relative">
                      <Switch
                        checked={Boolean(permissions[m.key]?.[a.key])}
                        onCheckedChange={() => toggle(m.key, a.key)}
                      />
                    </span>
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function MiniCard({ icon: Icon, label, value, sub, tint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; tint: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
          {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
        </div>
      </div>
    </Card>
  )
}
