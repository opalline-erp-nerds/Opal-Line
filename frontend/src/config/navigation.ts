import {
  Activity,
  ArrowLeftRight,
  Calculator,
  FileSpreadsheet,
  BarChart3,
  QrCode,
  ScanLine,
  BookOpen,
  Boxes,
  Building2,
  DatabaseBackup,
  FileText,
  Gem,
  Gift,
  HandCoins,
  KanbanSquare,
  Landmark,
  Layers,
  LayoutDashboard,
  ListOrdered,
  Package,
  Plug,
  PackageSearch,
  PackageX,
  Receipt,
  RefreshCcw,
  Server,
  Settings,
  ShoppingBag,
  Sparkles,
  ScrollText,
  Tags,
  TrendingUp,
  Truck,
  Undo2,
  UserCog,
  Users,
  Upload,
  UsersRound,
  Wallet,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  title: string
  path: string
  icon: LucideIcon
  badge?: string
}

export interface NavSection {
  label: string
  items: NavItem[]
}

export const navSections: NavSection[] = [
  {
    label: 'Main',
    items: [
      { title: 'Dashboard', path: '/', icon: LayoutDashboard },
      { title: 'Owner Insights', path: '/owner-insights', icon: BarChart3 },
      { title: 'Silver Rate', path: '/silver-rate', icon: Tags },
    ],
  },
  {
    label: 'Sales',
    items: [
      { title: 'Sales Invoices', path: '/sales/invoices', icon: FileText },
      { title: 'Quotations', path: '/sales/quotations', icon: FileSpreadsheet },
      { title: 'Sales Orders', path: '/sales/orders', icon: ListOrdered },
      { title: 'Order Pipeline', path: '/sales/pipeline', icon: KanbanSquare },
      { title: 'Dispatch', path: '/sales/dispatch', icon: Truck },
      { title: 'Customers', path: '/sales/customers', icon: Users },
      { title: 'Loyalty', path: '/sales/loyalty', icon: Gift },
      { title: 'Returns', path: '/sales/returns', icon: Undo2 },
      { title: 'Bookings', path: '/sales/bookings', icon: ShoppingBag },
    ],
  },
  {
    label: 'Purchase',
    items: [
      { title: 'Purchase Orders', path: '/purchase/orders', icon: ShoppingBag },
      { title: 'Purchase Invoices', path: '/purchase/invoices', icon: Receipt },
      { title: 'Suppliers', path: '/purchase/suppliers', icon: Building2 },
      { title: 'Returns', path: '/purchase/returns', icon: Undo2 },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { title: 'Products', path: '/inventory/products', icon: Gem },
      { title: 'Collections & Categories', path: '/inventory/collections', icon: Layers },
      { title: 'Stock Overview', path: '/inventory/stock', icon: Boxes },
      { title: 'Stock Transfer', path: '/inventory/transfers', icon: ArrowLeftRight },
      { title: 'Stock Locations', path: '/inventory/locations', icon: Warehouse },
      { title: 'QR Labels', path: '/inventory/barcode', icon: QrCode },
      { title: 'Low Stock Alert', path: '/inventory/low-stock', icon: PackageX },
      { title: 'Scan Stock Count', path: '/inventory/stock-count', icon: ScanLine },
      { title: 'Stock Running', path: '/inventory/stock-running', icon: TrendingUp },
    ],
  },
  {
    label: 'Accounts',
    items: [
      { title: 'Double-Entry Accounting', path: '/accounts/accounting', icon: Calculator },
      { title: 'Expenses', path: '/accounts/expenses', icon: Wallet },
      { title: 'Payments', path: '/accounts/payments', icon: HandCoins },
      { title: 'Bank Accounts', path: '/accounts/bank', icon: Landmark },
      { title: 'Ledger', path: '/accounts/ledger', icon: BookOpen },
      { title: 'Import Data', path: '/accounts/import', icon: Upload },
    ],
  },
  {
    label: 'Reports',
    items: [
      { title: 'Business Reports', path: '/reports/business', icon: BarChart3 },
      { title: 'Day Book', path: '/reports/day-book', icon: BookOpen },
      { title: 'GST Reports', path: '/reports/gst', icon: Receipt },
      { title: 'HSN Summary', path: '/reports/hsn', icon: FileSpreadsheet },
      { title: 'Sales Analysis', path: '/reports/sales', icon: TrendingUp },
      { title: 'Inventory Reports', path: '/reports/inventory', icon: PackageSearch },
      { title: 'Outstanding Dues', path: '/reports/dues', icon: HandCoins },
      { title: 'Supplier Dues', path: '/reports/supplier-dues', icon: Building2 },
    ],
  },
  {
    label: 'Shopify',
    items: [
      { title: 'Shopify Dashboard', path: '/shopify/dashboard', icon: Sparkles },
      { title: 'Orders Sync', path: '/shopify/orders', icon: ListOrdered },
      { title: 'Products Sync', path: '/shopify/products', icon: Package },
      { title: 'Sync Compare', path: '/shopify/compare', icon: ArrowLeftRight },
      { title: 'Inventory Sync', path: '/shopify/inventory', icon: Boxes },
      { title: 'Customers Sync', path: '/shopify/customers', icon: UsersRound },
      { title: 'Price Sync', path: '/shopify/price', icon: Tags },
      { title: 'Sync Logs', path: '/shopify/logs', icon: RefreshCcw },
      { title: 'Data Import', path: '/shopify/data-import', icon: Upload },
    ],
  },
  {
    label: 'System',
    items: [
      { title: 'Users & Roles', path: '/system/users', icon: UserCog },
      { title: 'Backup & Restore', path: '/system/backup', icon: DatabaseBackup },
      { title: 'System Status', path: '/system/status', icon: Server },
      { title: 'App Updates', path: '/system/updates', icon: RefreshCcw },
      { title: 'Settings', path: '/system/settings', icon: Settings },
      { title: 'Print Designer', path: '/system/print-designer', icon: FileText },
      { title: 'Connections', path: '/system/connections', icon: Plug },
      { title: 'Notifications', path: '/system/notifications', icon: Settings },
      { title: 'Notification Log', path: '/system/notification-log', icon: ScrollText },
      { title: 'Audit Logs', path: '/system/audit', icon: Activity },
      { title: 'Activity Log', path: '/system/activity', icon: ScrollText },
    ],
  },
]
