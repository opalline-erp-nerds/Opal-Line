import { toast } from '@/components/ui/confirm'
import { useEffect, useState } from 'react'
import { Mail, MessageCircle, RefreshCw, Save, PackageCheck, Send } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { dbApi, shopifyApi } from '@/lib/api'

interface NotificationSettings {
  dailySummaryEnabled: boolean
  monthlyStatementsEnabled: boolean
  dueRemindersEnabled: boolean
  weeklyReportEnabled: boolean
  recipientEmail: string
  orderFulfilledEmail?: boolean
  orderFulfilledWhatsapp?: boolean
  returnProcessedEmail?: boolean
  returnProcessedWhatsapp?: boolean
}

export default function NotificationSettingsPage() {
  const [settings, setSettings] = useState<NotificationSettings>({
    dailySummaryEnabled: true,
    monthlyStatementsEnabled: true,
    dueRemindersEnabled: true,
    weeklyReportEnabled: true,
    recipientEmail: '',
    orderFulfilledEmail: true,
    orderFulfilledWhatsapp: true,
    returnProcessedEmail: true,
    returnProcessedWhatsapp: true,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    dbApi.getNotificationSettings()
      .then((s) => setSettings({ ...s, recipientEmail: s.recipientEmail ?? '' }))
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await dbApi.updateNotificationSettings(settings)
      toast.success('Notification settings saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    try {
      const res = await shopifyApi.testEmail(settings.recipientEmail || undefined)
      if (res.ok) toast.success(`Test email sent to ${res.to}`)
      else toast.error(res.error ?? 'Test email failed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test email failed')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[800px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Notification Settings"
        subtitle="Configure email schedulers and notification recipients."
        actions={
          <Button onClick={save} disabled={saving || loading}>
            {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Settings
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Email Notifications
          </CardTitle>
          <CardDescription>Configure which automated emails are sent and to whom.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="recipient">Owner Notification Recipient</Label>
            <div className="flex gap-2">
              <Input
                id="recipient"
                type="email"
                value={settings.recipientEmail}
                onChange={(e) => setSettings({ ...settings, recipientEmail: e.target.value })}
                placeholder="admin@example.com"
                className="flex-1"
              />
              <Button variant="outline" onClick={sendTest} disabled={testing || loading}>
                {testing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send Test
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Owner emails (Daily Summary, Weekly Report, Supplier Payables) are sent to this address. Leave empty to fall
              back to the NOTIFICATION_EMAIL environment variable, then the business email. Customer emails always go to
              each customer's own address.
            </p>
          </div>

          <div className="space-y-4">
            <p className="text-sm font-medium text-muted-foreground">Owner emails — sent to the address above</p>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <p className="font-medium">Daily Summary</p>
                <p className="text-sm text-muted-foreground">Daily business summary at 9:00 AM with sales, orders, and low stock alerts.</p>
              </div>
              <Switch
                checked={settings.dailySummaryEnabled}
                onCheckedChange={(checked) => setSettings({ ...settings, dailySummaryEnabled: checked })}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <p className="font-medium">Weekly Owner Report</p>
                <p className="text-sm text-muted-foreground">Monday morning KPI summary with 8-week revenue/profit trend PDF.</p>
              </div>
              <Switch
                checked={settings.weeklyReportEnabled}
                onCheckedChange={(checked) => setSettings({ ...settings, weeklyReportEnabled: checked })}
              />
            </div>

            <p className="pt-2 text-sm font-medium text-muted-foreground">Customer emails — sent to each customer's own address</p>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <p className="font-medium">Monthly Customer Statements</p>
                <p className="text-sm text-muted-foreground">Account statements with PDF attached to customers on the 1st of each month.</p>
              </div>
              <Switch
                checked={settings.monthlyStatementsEnabled}
                onCheckedChange={(checked) => setSettings({ ...settings, monthlyStatementsEnabled: checked })}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <p className="font-medium">Due-Date Reminders</p>
                <p className="text-sm text-muted-foreground">Email customers 3 days before their invoices are due.</p>
              </div>
              <Switch
                checked={settings.dueRemindersEnabled}
                onCheckedChange={(checked) => setSettings({ ...settings, dueRemindersEnabled: checked })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-emerald-600" />
            Customer Order Notifications
          </CardTitle>
          <CardDescription>Automatic emails/WhatsApp messages to customers when their order status changes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <p className="font-medium">Order Fulfilled — Email</p>
              <p className="text-sm text-muted-foreground">Email the customer when their order is fulfilled/shipped (includes tracking number when available).</p>
            </div>
            <Switch
              checked={settings.orderFulfilledEmail !== false}
              onCheckedChange={(checked) => setSettings({ ...settings, orderFulfilledEmail: checked })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <p className="font-medium">Order Fulfilled — WhatsApp</p>
              <p className="text-sm text-muted-foreground">WhatsApp the customer when their order is fulfilled/shipped.</p>
            </div>
            <Switch
              checked={settings.orderFulfilledWhatsapp !== false}
              onCheckedChange={(checked) => setSettings({ ...settings, orderFulfilledWhatsapp: checked })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <p className="font-medium">Return Processed — Email</p>
              <p className="text-sm text-muted-foreground">Email the customer when a return is processed with their credit note.</p>
            </div>
            <Switch
              checked={settings.returnProcessedEmail !== false}
              onCheckedChange={(checked) => setSettings({ ...settings, returnProcessedEmail: checked })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <p className="font-medium">Return Processed — WhatsApp</p>
              <p className="text-sm text-muted-foreground">WhatsApp the customer when a return is processed with their credit note.</p>
            </div>
            <Switch
              checked={settings.returnProcessedWhatsapp !== false}
              onCheckedChange={(checked) => setSettings({ ...settings, returnProcessedWhatsapp: checked })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-emerald-600" />
            WhatsApp Business API
          </CardTitle>
          <CardDescription>Configure WhatsApp Business API for automated payment reminders and order updates.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              WhatsApp Business API integration is available when configured with environment variables:
            </p>
            <code className="mt-2 block rounded bg-muted px-3 py-2 text-xs">
              WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              When not configured, WhatsApp buttons fall back to wa.me deep links (client-side).
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
