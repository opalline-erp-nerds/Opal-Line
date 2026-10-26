import { useEffect, useState } from 'react'
import { Bell, Building2, Check, KeyRound, Landmark, Loader2, LogOut, Monitor, Moon, Package, Save, Settings as SettingsIcon, ShieldCheck, SlidersHorizontal, Sun, Tag, Users } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CreatableSelect } from '@/components/ui/creatable-select'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RequireModule } from '@/components/RequirePermission'
import { dbApi, authApi } from '@/lib/api'
import { confirmDialog, toast } from '@/components/ui/confirm'
import { useAuth } from '@/auth/auth-context'
import { setTheme, type Theme } from '@/lib/theme'
import { renderSku } from '@/lib/productCodes'
import type { AppSettings } from '@/types'

const DEFAULT_SETTINGS: AppSettings = {
  id: 'app',
  businessName: '',
  gstin: '',
  phone: '',
  email: '',
  address: '',
  defaultPurity: 92.5,
  makingCharge: 18,
  gstRate: 3,
  currency: 'inr',
  invoicePrefix: 'SI',
  rateSource: 'mcx',
  autoUpdateMcx: true,
  requireRateApproval: true,
  einvoiceEnabled: false,
  einvoiceMode: 'off',
  autoReconcileRazorpay: true,
  paymentReminders: false,
  lowStockAlerts: true,
  dailySummary: true,
  orderImports: true,
  loginLockoutEnabled: false,
  lockoutThreshold: 5,
  lockoutDurationMinutes: 15,
  skuPrefix: 'OL',
  skuSuffix: '',
  skuFormat: '{PREFIX}-{CATEGORY}-{SEQ}',
  skuSeqLength: 3,
  updatedAt: null,
}

/**
 * Merge a settings row without letting DB NULLs (or missing columns) win over
 * the defaults: a null reaching a controlled <input value> makes React warn
 * and flips the input between controlled/uncontrolled — which is exactly what
 * /system/settings logged whenever a settings column is NULL in the database.
 */
function withDefaults(row: Partial<AppSettings>): AppSettings {
  const clean = Object.fromEntries(
    Object.entries(row).filter(([, v]) => v !== null && v !== undefined),
  ) as Partial<AppSettings>
  return { ...DEFAULT_SETTINGS, ...clean }
}

export default function SettingsPage() {
  return (
    <RequireModule module="system">
      <SettingsContent />
    </RequireModule>
  )
}

function ComplianceCard() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [gateway, setGateway] = useState<{ provider: string; gatewayConfigured: boolean } | null>(null)

  useEffect(() => {
    dbApi.getSettings().then((row) => { if (row) setSettings(withDefaults(row)) }).catch(() => {})
    // The gateway state lives on the per-invoice status endpoint, so probe any
    // invoice-free response we have: a 404 still tells us nothing, so instead
    // ask for the mode through settings and infer the provider from the API.
    dbApi.getEInvoiceStatus('').catch(() => setGateway(null))
  }, [])

  const mode = settings.einvoiceMode ?? 'off'

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">E-Invoicing (GST IRN)</h3>
        </div>

        <Field label="IRN generation mode">
          {/* Fixed three-option enum on purpose: the mode drives the GST
              gateway integration — free text here would do nothing. */}
          <Select
            options={[
              { value: 'off', label: 'Off — never generate IRNs' },
              { value: 'manual', label: 'Manual — generate per invoice from the invoice page' },
              { value: 'automatic', label: 'Automatic — generate for every new invoice' },
            ]}
            value={mode}
            onValueChange={(v) => setSettings((s) => ({ ...s, einvoiceMode: v as AppSettings['einvoiceMode'], einvoiceEnabled: v !== 'off' }))}
            className="w-full"
          />
        </Field>

        <p className="text-[13px] text-muted-foreground">
          {mode === 'off'
            ? 'Invoices are issued without an IRN.'
            : mode === 'manual'
              ? 'Nothing is sent to the GST portal until someone clicks “Generate IRN” on the invoice.'
              : 'Every newly issued invoice is sent to the gateway automatically. Cancelling an IRN stays a manual action.'}
        </p>

        <div className="rounded-lg border p-4">
          <p className="text-sm font-medium text-foreground">Gateway</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {gateway?.gatewayConfigured
              ? `Connected via ${gateway.provider}.`
              : 'No live gateway connected — IRNs are generated locally so the full flow can be used and reviewed. Add CLEARTAX_GSTIN and CLEARTAX_AUTH_TOKEN to the environment to go live, or extend the provider adapter.'}
          </p>
          {settings.gstin ? (
            <p className="mt-2 text-xs text-muted-foreground">
              GSTIN on file: <span className="font-mono text-foreground">{settings.gstin}</span>
            </p>
          ) : (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              Add your GSTIN in the Business tab before generating IRNs — it is written into every e-invoice.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function SettingsContent() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    dbApi
      .getSettings()
      .then((row) => {
        if (row) setSettings(withDefaults(row))
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }))
    setStatus('idle')
  }

  const save = async () => {
    setSaving(true)
    setStatus('idle')
    setError('')
    try {
      const saved = await dbApi.updateSettings(settings)
      setSettings((s) => ({ ...s, ...saved }))
      setStatus('saved')
    } catch {
      setError('Failed to save settings')
      setStatus('error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Settings"
        subtitle="Business profile, silver-rate preferences, notifications and integrations."
        actions={
          <>
            {status === 'saved' ? (
              <span className="flex items-center gap-1.5 text-sm font-medium text-success-600">
                <Check className="h-4 w-4" /> Saved
              </span>
            ) : null}
            {status === 'error' ? <span className="text-sm font-medium text-red-600 dark:text-red-400">{error}</span> : null}
            <Button size="sm" onClick={save} disabled={saving || !loaded}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </>
        }
      />

      <Tabs defaultValue="business">
        <TabsList>
          <TabsTrigger value="business"><Building2 /> Business</TabsTrigger>
          <TabsTrigger value="products"><Package /> Product Codes</TabsTrigger>
          <TabsTrigger value="appearance"><Sun /> Appearance</TabsTrigger>
          <TabsTrigger value="silver"><Tag /> Silver Rate</TabsTrigger>
          <TabsTrigger value="banking"><Landmark /> Banking</TabsTrigger>
          <TabsTrigger value="notifications"><Bell /> Notifications</TabsTrigger>
          <TabsTrigger value="compliance"><ShieldCheck /> Compliance</TabsTrigger>
          <TabsTrigger value="team"><Users /> Team</TabsTrigger>
        </TabsList>

        <TabsContent value="compliance">
          <ComplianceCard />
        </TabsContent>

        <TabsContent value="appearance">
          <AppearanceCard />
        </TabsContent>

        <TabsContent value="business">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">Business Profile</h3>
                </div>
                <Field label="Business Name">
                  <Input value={settings.businessName} onChange={(e) => set('businessName', e.target.value)} />
                </Field>
                <Field label="GSTIN">
                  <Input value={settings.gstin} onChange={(e) => set('gstin', e.target.value)} />
                </Field>
                <Field label="Phone">
                  <Input value={settings.phone} onChange={(e) => set('phone', e.target.value)} />
                </Field>
                <Field label="Email">
                  <Input value={settings.email} onChange={(e) => set('email', e.target.value)} />
                </Field>
                <Field label="Address">
                  <Input value={settings.address} onChange={(e) => set('address', e.target.value)} />
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">Defaults</h3>
                </div>
                <Field label="Default Silver Purity">
                  {/* CreatableSelect keeps the three common presets but also
                      accepts any typed purity (e.g. 90, 80, 999) — manual
                      entry is validated before it is stored. */}
                  <CreatableSelect
                    options={[
                      { value: '92.5', label: '92.5% (Sterling)' },
                      { value: '95.8', label: '95.8% (Britannia)' },
                      { value: '99.9', label: '99.9% (Fine)' },
                    ]}
                    value={String(settings.defaultPurity)}
                    onValueChange={(v) => {
                      const n = Number(v)
                      if (!Number.isFinite(n) || n <= 0 || n > 999.9) {
                        toast.error('Purity must be a number up to 999.9 (e.g. 90 or 99.9)')
                        return
                      }
                      set('defaultPurity', n)
                    }}
                    placeholder="Pick a purity or type any %"
                    className="w-full"
                  />
                </Field>
                <Field label="Making Charge (₹/g)">
                  <Input type="number" value={settings.makingCharge} onChange={(e) => set('makingCharge', Number(e.target.value))} />
                </Field>
                <Field label="GST Rate (%)">
                  <Input type="number" value={settings.gstRate} onChange={(e) => set('gstRate', Number(e.target.value))} />
                </Field>
                <Field label="Currency">
                  {/* Presets plus free typing of any 3-letter ISO code — the
                      code is stored verbatim and used for labels/formatting. */}
                  <CreatableSelect
                    options={[
                      { value: 'inr', label: 'Indian Rupee (₹)' },
                      { value: 'usd', label: 'US Dollar ($)' },
                    ]}
                    value={settings.currency}
                    onValueChange={(v) => {
                      const code = v.trim().toLowerCase()
                      if (!/^[a-z]{3}$/.test(code)) {
                        toast.error('Currency must be a 3-letter ISO code (e.g. inr, usd, aed)')
                        return
                      }
                      set('currency', code)
                    }}
                    placeholder="Pick a currency or type any ISO code"
                    className="w-full"
                  />
                </Field>
                <Field label="Invoice Prefix">
                  <Input value={settings.invoicePrefix} onChange={(e) => set('invoicePrefix', e.target.value)} />
                </Field>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="products">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">SKU auto-generation</h3>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  New products get a free SKU on this format. The tokens are replaced when the code is generated:
                  {' '}<span className="font-mono text-foreground">{'{PREFIX}'}</span>,{' '}
                  <span className="font-mono text-foreground">{'{CATEGORY}'}</span> (3-letter category code),{' '}
                  <span className="font-mono text-foreground">{'{SEQ}'}</span> (running number) and{' '}
                  <span className="font-mono text-foreground">{'{SUFFIX}'}</span>.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Prefix">
                    <Input
                      aria-label="SKU prefix"
                      value={settings.skuPrefix ?? 'OL'}
                      onChange={(e) => set('skuPrefix', e.target.value.toUpperCase())}
                      maxLength={12}
                      placeholder="OL"
                    />
                  </Field>
                  <Field label="Suffix">
                    <Input
                      aria-label="SKU suffix"
                      value={settings.skuSuffix ?? ''}
                      onChange={(e) => set('skuSuffix', e.target.value.toUpperCase())}
                      maxLength={12}
                      placeholder="None"
                    />
                  </Field>
                  <Field label="ID format">
                    {/* Fixed template enum plus free typing of any token
                        arrangement — a format without {SEQ} would mint
                        identical SKUs forever, so it is rejected. */}
                    <CreatableSelect
                      options={[
                        { value: '{PREFIX}-{CATEGORY}-{SEQ}', label: 'PREFIX-CATEGORY-SEQ — OL-RNG-001' },
                        { value: '{PREFIX}-{SEQ}{SUFFIX}', label: 'PREFIX-SEQ SUFFIX — OL-001' },
                        { value: '{CATEGORY}-{SEQ}', label: 'CATEGORY-SEQ — RNG-001' },
                        { value: '{PREFIX}{CATEGORY}{SEQ}', label: 'PREFIXCATEGORYSEQ — OLRNG001' },
                      ]}
                      value={settings.skuFormat ?? '{PREFIX}-{CATEGORY}-{SEQ}'}
                      onValueChange={(v) => {
                        if (!v.includes('{SEQ}')) {
                          toast.error('The ID format must contain {SEQ} so every SKU is unique')
                          return
                        }
                        set('skuFormat', v)
                      }}
                      placeholder="Pick a format or type your own"
                      createLabel="Use this format"
                      className="w-full"
                    />
                  </Field>
                  <Field label="Sequence digits">
                    <Input
                      type="number"
                      min={3}
                      max={8}
                      aria-label="SKU sequence digits"
                      value={settings.skuSeqLength ?? 3}
                      onChange={(e) => set('skuSeqLength', Math.max(3, Number(e.target.value) || 3))}
                    />
                    <p className="text-[11px] text-muted-foreground">Minimum 3 — sequences are three digits, e.g. 001.</p>
                  </Field>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Preview</p>
                  <p className="mt-0.5 font-mono text-sm text-foreground" data-testid="sku-preview">
                    {renderSku(settings, 'Rings', 42)}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="silver">
          <Card>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <Tag className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground">Silver Rate Settings</h3>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Rate Source">
                  {/* Fixed two-option enum on purpose: both values drive
                      backend behaviour (the MCX scheduler vs manual entry),
                      so a free-typed source could never do anything. */}
                  <Select
                    options={[
                      { value: 'mcx', label: 'MCX Mumbai' },
                      { value: 'manual', label: 'Manual Entry' },
                    ]}
                    value={settings.rateSource}
                    onValueChange={(v) => set('rateSource', v)}
                    className="w-full"
                  />
                </Field>
              </div>
              <SettingRow
                title="Auto-update from MCX"
                description="Fetch daily silver closing rate automatically."
                checked={settings.autoUpdateMcx}
                onCheckedChange={(v) => set('autoUpdateMcx', v)}
              />
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-semibold text-foreground">Admin approval is always required for staff rate changes.</span>{' '}
                  Rate changes submitted by anyone other than an Admin or Super Admin are queued for approval and do not
                  apply until accepted.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="banking">
          <Card>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <Landmark className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground">Payment & Settlement</h3>
              </div>
              <SettingRow
                title="Auto-reconcile Razorpay settlements"
                description="Match incoming Razorpay payments to invoices automatically."
                checked={settings.autoReconcileRazorpay}
                onCheckedChange={(v) => set('autoReconcileRazorpay', v)}
              />
              <SettingRow
                title="Send payment reminders for overdue invoices"
                description="Automatically email customers after 7 days past due."
                checked={settings.paymentReminders}
                onCheckedChange={(v) => set('paymentReminders', v)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications">
          <Card>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground">Notifications</h3>
              </div>
              <SettingRow
                title="Low stock alerts"
                description="Notify when inventory falls below reorder level."
                checked={settings.lowStockAlerts}
                onCheckedChange={(v) => set('lowStockAlerts', v)}
              />
              <SettingRow
                title="Daily business summary"
                description="Email summary of sales, orders and expenses each morning."
                checked={settings.dailySummary}
                onCheckedChange={(v) => set('dailySummary', v)}
              />
              <SettingRow
                title="Shopify order imports"
                description="Notify on successful order imports and sync failures."
                checked={settings.orderImports}
                onCheckedChange={(v) => set('orderImports', v)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="team">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <SettingsIcon className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">Role Permissions</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Manage role-based access to modules. Fine-grained permissions are configured per user in Users & Roles.
                </p>
              </CardContent>
            </Card>

            <SessionSecurityCard />
            <RecoveryPasswordCard />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

type ThemeChoice = Theme | 'system'

function AppearanceCard() {
  // 'system' is stored as absence of an explicit choice; detect current effective theme.
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('opal-theme') : null
    return saved === 'dark' || saved === 'light' ? saved : 'system'
  })

  const apply = (next: ThemeChoice) => {
    setChoice(next)
    if (next === 'system') {
      window.localStorage.removeItem('opal-theme')
      const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
      setTheme(prefersDark ? 'dark' : 'light')
    } else {
      setTheme(next)
    }
  }

  const options: Array<{ value: ThemeChoice; label: string; icon: typeof Sun; description: string }> = [
    { value: 'light', label: 'Light', icon: Sun, description: 'Bright interface for well-lit rooms' },
    { value: 'dark', label: 'Dark', icon: Moon, description: 'Easy on the eyes in low light' },
    { value: 'system', label: 'System', icon: Monitor, description: 'Match your device setting automatically' },
  ]

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-2">
          <Sun className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">Theme</h3>
        </div>
        <p className="text-sm text-muted-foreground">Choose how Opal Line looks. This applies immediately and is remembered on this device.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {options.map((opt) => {
            const Icon = opt.icon
            const active = choice === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => apply(opt.value)}
                className={`flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors ${active ? 'border-primary-500 bg-accent ring-1 ring-primary-500' : 'border-border hover:border-primary-300 hover:bg-muted/40'}`}
              >
                <div className="flex w-full items-center justify-between">
                  <Icon className={`h-5 w-5 ${active ? 'text-primary-600' : 'text-muted-foreground'}`} />
                  {active ? (
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-primary-600">
                      <Check className="h-3.5 w-3.5" /> Active
                    </span>
                  ) : null}
                </div>
                <span className="text-sm font-semibold text-foreground">{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.description}</span>
                {/* Mini preview strip */}
                <div className="mt-1 flex h-8 w-full overflow-hidden rounded border border-border">
                  <div className={`w-1/4 ${opt.value === 'dark' ? 'bg-[#241a35]' : 'bg-[#2e2550]'}`} />
                  <div className={`flex-1 ${opt.value === 'dark' ? 'bg-[#12151d]' : 'bg-[#f5f4fa]'}`} />
                </div>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">The 🌙 button in the header toggles between light and dark instantly; System keeps following your device.</p>
      </CardContent>
    </Card>
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

function SettingRow({ title, description, checked, onCheckedChange }: { title: string; description: string; checked: boolean; onCheckedChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={title} />
    </div>
  )
}

function SessionSecurityCard() {
  const { currentUser, hasPermission } = useAuth()
  const [revoking, setRevoking] = useState(false)
  // Login lockout is a per-install setting saved straight to settings (there
  // is no form-wide Save in this card): the switch plus editable
  // attempts-before-lockout and lockout-minutes values, mirroring the
  // recovery-password card. Kept as strings while typing so partial input
  // (an empty box) doesn't fight the controlled input; validated before save.
  const [lockout, setLockout] = useState(false)
  const [threshold, setThreshold] = useState('5')
  const [durationMin, setDurationMin] = useState('15')
  const [lockoutSaving, setLockoutSaving] = useState(false)
  const canEdit = hasPermission('system', 'edit')

  useEffect(() => {
    dbApi.getSettings()
      .then((row) => {
        if (!row) return
        setLockout(row.loginLockoutEnabled === true)
        if (row.lockoutThreshold != null) setThreshold(String(row.lockoutThreshold))
        if (row.lockoutDurationMinutes != null) setDurationMin(String(row.lockoutDurationMinutes))
      })
      .catch(() => {})
  }, [])

  // Same bounds the backend clamps to (src/lockout.ts) — the Save button
  // stays disabled outside them so a stored rule is always intentional.
  const thresholdNum = Number(threshold)
  const durationNum = Number(durationMin)
  const thresholdValid = Number.isInteger(thresholdNum) && thresholdNum >= 1 && thresholdNum <= 50
  const durationValid = Number.isInteger(durationNum) && durationNum >= 1 && durationNum <= 1440
  const lockoutRulesValid = thresholdValid && durationValid

  const persistLockout = async (patch: {
    loginLockoutEnabled?: boolean
    lockoutThreshold?: number
    lockoutDurationMinutes?: number
  }) => {
    const previous = { enabled: lockout, threshold, minutes: durationMin }
    // Optimistic apply, rolled back on error (the switch should feel instant).
    if (patch.loginLockoutEnabled !== undefined) setLockout(patch.loginLockoutEnabled)
    if (patch.lockoutThreshold !== undefined) setThreshold(String(patch.lockoutThreshold))
    if (patch.lockoutDurationMinutes !== undefined) setDurationMin(String(patch.lockoutDurationMinutes))
    setLockoutSaving(true)
    try {
      const saved = await dbApi.updateSettings(patch)
      if (saved) {
        setLockout(saved.loginLockoutEnabled === true)
        if (saved.lockoutThreshold != null) setThreshold(String(saved.lockoutThreshold))
        if (saved.lockoutDurationMinutes != null) setDurationMin(String(saved.lockoutDurationMinutes))
      }
      const nextThreshold = saved?.lockoutThreshold ?? patch.lockoutThreshold ?? Number(previous.threshold)
      const nextMinutes = saved?.lockoutDurationMinutes ?? patch.lockoutDurationMinutes ?? Number(previous.minutes)
      toast.success(
        saved?.loginLockoutEnabled === true
          ? `Login lockout enabled — ${nextThreshold} failed attempts now lock the account for ${nextMinutes} minutes`
          : 'Login lockout disabled — failed attempts no longer lock accounts',
      )
    } catch (err) {
      setLockout(previous.enabled)
      setThreshold(previous.threshold)
      setDurationMin(previous.minutes)
      toast.error(err instanceof Error ? err.message : 'Could not update the login lockout')
    } finally {
      setLockoutSaving(false)
    }
  }

  const toggleLockout = (v: boolean) => { void persistLockout({ loginLockoutEnabled: v }) }
  const saveLockoutRules = () => {
    if (!lockoutRulesValid) {
      toast.error('Attempts must be a whole number 1–50 and duration 1–1440 minutes')
      return
    }
    void persistLockout({ lockoutThreshold: thresholdNum, lockoutDurationMinutes: durationNum })
  }

  const revokeOthers = async () => {
    if (
      !(await confirmDialog({
        title: 'Log out other devices?',
        description: 'Every other signed-in session for your account will be revoked. This device stays signed in.',
        confirmLabel: 'Log out others',
        danger: true,
      }))
    )
      return
    setRevoking(true)
    try {
      const r = await authApi.logoutOtherSessions()
      toast.success(`Signed out ${r.revoked} other session${r.revoked === 1 ? '' : 's'}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not log out other devices')
    } finally {
      setRevoking(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">Security</h3>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-sm font-medium text-foreground">Devices</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Signed in as {currentUser?.name ?? 'you'}. Revoke all other sessions if you left a device signed in somewhere.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={revokeOthers} disabled={revoking}>
            <LogOut className="h-3.5 w-3.5" /> {revoking ? 'Signing out…' : 'Log out other devices'}
          </Button>
        </div>
        {canEdit ? (
          <>
            <SettingRow
              title="Login lockout"
              description="After the set number of failed sign-in attempts, block that account for the set time (recorded in the activity log). Off by default while testing — turn it on for production."
              checked={lockout}
              onCheckedChange={toggleLockout}
            />
            <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="lockout-attempts">Attempts before lockout</Label>
                <Input
                  id="lockout-attempts"
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  disabled={lockoutSaving}
                />
                {!thresholdValid ? <p className="text-xs text-destructive">Use a whole number from 1 to 50.</p> : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="lockout-minutes">Lockout duration (minutes)</Label>
                <Input
                  id="lockout-minutes"
                  type="number"
                  min={1}
                  max={1440}
                  step={1}
                  value={durationMin}
                  onChange={(e) => setDurationMin(e.target.value)}
                  disabled={lockoutSaving}
                />
                {!durationValid ? <p className="text-xs text-destructive">Use a whole number from 1 to 1440.</p> : null}
              </div>
              <div className="sm:col-span-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={saveLockoutRules}
                  disabled={lockoutSaving || !lockoutRulesValid}
                >
                  <Save className="h-3.5 w-3.5" /> Save lockout rules
                </Button>
              </div>
            </div>
          </>
        ) : null}
        {lockoutSaving ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving…
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function RecoveryPasswordCard() {
  const { currentUser } = useAuth()
  const isOwner = currentUser?.role === 'Admin' || currentUser?.role === 'Super Admin'
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [source, setSource] = useState<'default' | 'custom'>('default')
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!isOwner) return
    dbApi
      .getRecoveryPasswordState()
      .then((r) => setSource(r.source))
      .catch(() => toast.error('Could not load the recovery password'))
      .finally(() => setLoading(false))
  }, [isOwner])

  // Mirrors the backend strongPassword policy so the user is not told about
  // the rules only after the server rejects the value.
  const valid =
    draft.length >= 8 && /[A-Z]/.test(draft) && /[a-z]/.test(draft) && /[0-9]/.test(draft) && /[^A-Za-z0-9]/.test(draft)

  const save = async () => {
    if (!valid) return
    setSaving(true)
    try {
      const r = await dbApi.setRecoveryPassword(draft)
      setSource(r.source)
      setDraft('')
      toast.success('Recovery password updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the recovery password')
    } finally {
      setSaving(false)
    }
  }

  const resetToDefault = async () => {
    if (
      !(await confirmDialog({
        title: 'Reset to the built-in recovery password?',
        description: 'The custom value will be discarded and the default shipped with the app becomes effective again.',
        confirmLabel: 'Reset to default',
        danger: true,
      }))
    )
      return
    setSaving(true)
    try {
      const r = await dbApi.resetRecoveryPassword()
      setSource(r.source)
      setDraft('')
      toast.success('Recovery password reset to the built-in default')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reset the recovery password')
    } finally {
      setSaving(false)
    }
  }

  if (!isOwner) return null

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">Recovery password</h3>
        </div>
        <div className="rounded-lg border p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Forgot your sign-in password? Type this recovery password in the Password box on the Sign-in screen — it works as
            the password for Admin and Super Admin accounts only, and every use is recorded in the activity log.
          </p>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Current recovery password ({source === 'default' ? 'built-in default' : 'custom value'})
            </Label>
            <Input
              type="text"
              readOnly
              value="••••••••••"
              aria-label="Current recovery password (hidden)"
              disabled={loading}
            />
            <p className="text-[11px] text-muted-foreground">
              The value is stored only as a one-way Argon2 hash and cannot be displayed here. If you do not have it, set a
              new value below or reset to the built-in default (see the installation guide).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Set a new recovery password (optional)</Label>
            <Input
              type="password"
              placeholder="At least 8 chars with upper, lower, number and symbol"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="New recovery password"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={!valid || saving || loading}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save new value
            </Button>
            <Button size="sm" variant="outline" onClick={resetToDefault} disabled={saving || source === 'default'}>
              Reset to built-in default
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
