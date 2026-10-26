import * as React from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AppDialog } from '@/components/ui/app-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { Supplier } from '@/types'

interface SupplierDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: 'add' | 'edit'
  supplier?: Supplier | null
  onSubmit: (payload: SupplierFormPayload) => Promise<void>
  saving?: boolean
  error?: string | null
}

export interface SupplierFormPayload {
  name: string
  contact: string
  phone: string
  alternatePhone: string
  email: string
  gstin: string
  city: string
  address: string
  status: 'active' | 'inactive'
}

const EMPTY_FORM: SupplierFormPayload = {
  name: '',
  contact: '',
  phone: '',
  alternatePhone: '',
  email: '',
  gstin: '',
  city: '',
  address: '',
  status: 'active',
}

export function SupplierDialog({
  open,
  onOpenChange,
  mode = 'add',
  supplier,
  onSubmit,
  saving,
  error,
}: SupplierDialogProps) {
  const [form, setForm] = React.useState<SupplierFormPayload>(EMPTY_FORM)
  // Snapshot of the form as it opened, for the unsaved-changes close guard.
  const [baseline, setBaseline] = React.useState('')

  React.useEffect(() => {
    if (!open) {
      queueMicrotask(() => setForm(EMPTY_FORM))
      return
    }
    const next: SupplierFormPayload =
      supplier && mode === 'edit'
        ? {
            name: supplier.name ?? '',
            contact: supplier.contact ?? '',
            phone: supplier.phone ?? '',
            alternatePhone: supplier.alternatePhone ?? '',
            email: supplier.email ?? '',
            gstin: supplier.gstin ?? '',
            city: supplier.city ?? '',
            address: supplier.address ?? '',
            status: supplier.status ?? 'active',
          }
        : EMPTY_FORM
    queueMicrotask(() => {
      setForm(next)
      setBaseline(JSON.stringify(next))
    })
  }, [open, supplier, mode])

  const setField = (key: keyof SupplierFormPayload, value: string) =>
    setForm((f) => ({ ...f, [key]: value }))

  const handleSubmit = async () => {
    await onSubmit(form)
  }

  const title = mode === 'edit' ? 'Edit Supplier' : 'Add Supplier'
  const description =
    mode === 'edit'
      ? 'Update supplier contact details, email, GSTIN and address.'
      : 'Register a new silver supplier with contact details.'

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      isDirty={open && JSON.stringify(form) !== baseline}
      title={title}
      description={description}
      footer={
        <div className="flex flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'add' ? <Plus className="h-4 w-4" /> : null}
            {mode === 'add' ? 'Add Supplier' : 'Save Changes'}
          </Button>
        </div>
      }
    >

        <div className="grid gap-4">
          <Field label="Supplier Name *">
            <Input
              placeholder="e.g. Goyal Silver House"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Contact Person">
              <Input
                placeholder="e.g. Ramesh Goyal"
                value={form.contact}
                onChange={(e) => setField('contact', e.target.value)}
              />
            </Field>
            <Field label="City">
              <Input
                placeholder="e.g. Mumbai"
                value={form.city}
                onChange={(e) => setField('city', e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone">
              <Input
                placeholder="+91 ..."
                value={form.phone}
                onChange={(e) => setField('phone', e.target.value)}
              />
            </Field>
            <Field label="Alternate Phone">
              <Input
                placeholder="+91 ..."
                value={form.alternatePhone}
                onChange={(e) => setField('alternatePhone', e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email">
              <Input
                type="email"
                placeholder="e.g. accounts@goyal.co.in"
                value={form.email}
                onChange={(e) => setField('email', e.target.value)}
              />
            </Field>
            <Field label="GSTIN">
              <Input
                placeholder="27AAAAA0000A1Z5"
                value={form.gstin}
                onChange={(e) => setField('gstin', e.target.value.toUpperCase())}
                className="uppercase tracking-wide"
              />
            </Field>
          </div>

          <Field label="Address">
            <Textarea
              value={form.address}
              onChange={(e) => setField('address', e.target.value)}
              placeholder="Billing/shipping address of the supplier"
              rows={3}
              className={cn(
                'min-h-[80px] w-full resize-y rounded-md border bg-transparent p-2 text-sm outline-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-primary/60',
              )}
            />
          </Field>

          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
    </AppDialog>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
