import { AlertCircle, CloudOff } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

export function SyncErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-red-200 bg-red-50/50 dark:border-red-700/60 dark:bg-red-950/40">
      <CardContent className="flex items-center gap-3 p-4 text-sm text-red-700">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <p>
          {message}. Is the backend running? Start it with{' '}
          <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs dark:bg-red-900/50">npm run dev --prefix backend</code>.
        </p>
      </CardContent>
    </Card>
  )
}

export function ShopifyNotConfigured() {
  return (
    <Card className="border-warning-100 bg-warning-50/50">
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-warning-100 text-warning-700">
            <CloudOff className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Shopify is not connected yet</p>
            <p className="text-[13px] text-muted-foreground">Add your store credentials to connect this app to your Shopify store.</p>
          </div>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
          <li>In Shopify admin: <strong>Settings → Apps and sales channels → Develop apps → Create an app</strong></li>
          <li>Grant Admin API scopes: <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">read_orders, read_products, read_inventory, read_customers</code></li>
          <li>Install the app and copy the <strong>Admin API access token</strong></li>
          <li>
            Copy <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">backend/.env.example</code> to{' '}
            <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">backend/.env</code>, fill in{' '}
            <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">SHOPIFY_STORE_URL</code> and{' '}
            <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">SHOPIFY_ACCESS_TOKEN</code>, restart the
            server, then click <strong>Sync Now</strong>.
          </li>
        </ol>
      </CardContent>
    </Card>
  )
}
