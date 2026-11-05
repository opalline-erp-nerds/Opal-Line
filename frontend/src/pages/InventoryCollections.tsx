import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderTree, Layers, Loader2, Lock, Pencil, Plus, Search, Tags } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { DataTable } from '@/components/ui/data-table'
import { AppDialog } from '@/components/ui/app-dialog'
import { DialogFooter } from '@/components/ui/dialog'
import { toast } from '@/components/ui/confirm'
import { useAuth } from '@/auth/auth-context'
import { dbApi } from '@/lib/api'
import { categoryCode } from '@/lib/productCodes'
import { cn } from '@/lib/utils'
import type { ColumnDef } from '@/lib/table'
import type { ProductCategory, ProductCollection } from '@/types'

type CategoryDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; category: ProductCategory }
  | null

const PRICING_LABEL: Record<string, string> = {
  silver: 'Silver rate',
  fixed: 'Fixed price',
}

/**
 * Inventory → Collections & Categories.
 *
 * Manages the pricing collections and their categories only:
 *   • Silver Jewels keeps its silver-rate pricing and immutable name.
 *   • Other Products is the independent fixed-price group; its display name can
 *     be changed at any time, while its stable id never changes.
 *
 * Product prices, SKUs, sales and Shopify are untouched by everything here —
 * the page defines how the catalogue is grouped for the pricing work that
 * follows.
 */
export default function InventoryCollectionsPage() {
  const { hasPermission } = useAuth()
  const canCreate = hasPermission('inventory', 'create')
  const canEdit = hasPermission('inventory', 'edit')

  const [collections, setCollections] = useState<ProductCollection[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  // Rename dialog (only non-system collections can be renamed).
  const [renameTarget, setRenameTarget] = useState<ProductCollection | null>(null)
  const [renameName, setRenameName] = useState('')
  const [savingRename, setSavingRename] = useState(false)

  // Create / edit category dialog.
  const [categoryDialog, setCategoryDialog] = useState<CategoryDialogState>(null)
  const [categoryForm, setCategoryForm] = useState({ name: '', prefix: '', collectionId: '' })
  const [prefixTouched, setPrefixTouched] = useState(false)
  const [savingCategory, setSavingCategory] = useState(false)
  const [categoryError, setCategoryError] = useState('')

  const loadCollections = useCallback(() => {
    setLoading(true)
    dbApi
      .getCollections()
      .then((rows) => {
        setCollections(rows)
        setSelectedId((current) => {
          if (current && rows.some((c) => c.id === current)) return current
          // The fixed-price collection is the one this page is primarily for.
          return rows.find((c) => c.pricingType === 'fixed')?.id ?? rows[0]?.id ?? ''
        })
      })
      .catch(() => toast.error('Could not load collections'))
      .finally(() => setLoading(false))
  }, [])

  const loadCategories = useCallback((collectionId: string) => {
    if (!collectionId) {
      setCategories([])
      return
    }
    dbApi
      .getProductCategories(collectionId)
      .then(setCategories)
      .catch(() => toast.error('Could not load categories'))
  }, [])

  useEffect(() => {
    queueMicrotask(loadCollections)
  }, [loadCollections])

  useEffect(() => {
    if (!selectedId) return
    queueMicrotask(() => loadCategories(selectedId))
  }, [selectedId, loadCategories])

  const selected = useMemo(
    () => collections.find((c) => c.id === selectedId) ?? null,
    [collections, selectedId],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return categories
    return categories.filter(
      (c) => c.name.toLowerCase().includes(q) || c.prefix.toLowerCase().includes(q),
    )
  }, [categories, query])

  const openRename = (collection: ProductCollection) => {
    setRenameTarget(collection)
    setRenameName(collection.name)
  }

  const submitRename = async () => {
    if (!renameTarget) return
    const name = renameName.trim()
    if (!name) {
      toast.error('Give the collection a name')
      return
    }
    setSavingRename(true)
    try {
      await dbApi.renameCollection(renameTarget.id, name)
      toast.success(`Collection renamed to “${name}” — its ID stays ${renameTarget.id}`)
      setRenameTarget(null)
      loadCollections()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename the collection')
    } finally {
      setSavingRename(false)
    }
  }

  const openCreateCategory = () => {
    setCategoryError('')
    setPrefixTouched(false)
    setCategoryForm({ name: '', prefix: '', collectionId: selectedId })
    setCategoryDialog({ mode: 'create' })
  }

  const openEditCategory = useCallback((category: ProductCategory) => {
    setCategoryError('')
    setPrefixTouched(true)
    setCategoryForm({ name: category.name, prefix: category.prefix, collectionId: category.collectionId })
    setCategoryDialog({ mode: 'edit', category })
  }, [])

  const setCategoryName = (value: string) => {
    setCategoryForm((f) => {
      // Suggest the prefix from the name until the user edits it by hand.
      const nextPrefix = prefixTouched ? f.prefix : value.trim() ? categoryCode(value) : ''
      return { ...f, name: value, prefix: nextPrefix }
    })
  }

  const submitCategory = async () => {
    const name = categoryForm.name.trim()
    const prefix = categoryForm.prefix.trim().toUpperCase()
    if (!name) {
      setCategoryError('Category name is required')
      return
    }
    if (!/^[A-Z]{2,5}$/.test(prefix)) {
      setCategoryError('SKU prefix must be 2–5 letters (A–Z), e.g. BAG')
      return
    }
    if (!categoryForm.collectionId) {
      setCategoryError('Choose the collection this category belongs to')
      return
    }
    setSavingCategory(true)
    setCategoryError('')
    try {
      if (categoryDialog?.mode === 'edit') {
        const res = await dbApi.updateProductCategory(categoryDialog.category.id, {
          name,
          prefix,
          collectionId: categoryForm.collectionId,
        })
        toast.success(
          res.productsUpdated > 0
            ? `Category updated — ${res.productsUpdated} product(s) relabelled`
            : 'Category updated',
        )
      } else {
        await dbApi.createProductCategory({ name, prefix, collectionId: categoryForm.collectionId })
        toast.success(`Category “${name}” created`)
      }
      setCategoryDialog(null)
      loadCollections()
      // Follow the category into its collection; reload in place when the
      // collection did not change (the effect only fires on a new id).
      if (categoryForm.collectionId !== selectedId) {
        setSelectedId(categoryForm.collectionId)
      } else {
        loadCategories(categoryForm.collectionId)
      }
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : 'Could not save the category')
    } finally {
      setSavingCategory(false)
    }
  }

  const columns = useMemo<ColumnDef<ProductCategory>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Category',
        meta: { headerClassName: 'min-w-[220px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <FolderTree className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{row.original.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {row.original.productCount} product{row.original.productCount === 1 ? '' : 's'} in the catalogue
              </p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'prefix',
        header: 'SKU prefix',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-foreground">
            <Tags className="h-3.5 w-3.5 text-muted-foreground" />
            {row.original.prefix}
          </span>
        ),
      },
      {
        id: 'products',
        header: 'Products',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="tabular-nums text-foreground">{row.original.productCount}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        meta: { align: 'right' as const },
        cell: ({ row }) =>
          canEdit ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${row.original.name}`}
              onClick={() => openEditCategory(row.original)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          ) : null,
      },
    ],
    [canEdit, openEditCategory],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Collections & Categories"
        subtitle="Group the catalogue for pricing. Silver Jewels keeps silver-rate pricing; Other Products is the fixed-price collection and can be renamed at any time."
        actions={
          canCreate ? (
            <Button size="sm" onClick={openCreateCategory} disabled={!selectedId}>
              <Plus className="h-4 w-4" /> New Category
            </Button>
          ) : null
        }
      />

      <div className="grid gap-3 md:grid-cols-2">
        {collections.map((collection) => {
          const active = collection.id === selectedId
          return (
            <div
              key={collection.id}
              className={cn(
                'rounded-lg border bg-card p-4 shadow-card transition-colors',
                active ? 'border-primary-400 ring-1 ring-primary-400/40' : 'hover:border-foreground/20',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedId(collection.id)}
                  aria-pressed={active}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{collection.name}</span>
                    <Badge variant={collection.pricingType === 'fixed' ? 'info' : 'purple'} dot>
                      {PRICING_LABEL[collection.pricingType] ?? collection.pricingType}
                    </Badge>
                    {collection.isSystem ? (
                      <Badge variant="muted">
                        <Lock className="h-3 w-3" /> System
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">ID {collection.id}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {collection.categoryCount} categor{collection.categoryCount === 1 ? 'y' : 'ies'} ·{' '}
                    {collection.productCount} product{collection.productCount === 1 ? '' : 's'}
                  </p>
                </button>
                {canEdit && !collection.isSystem ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openRename(collection)}
                    aria-label={`Rename ${collection.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Rename
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
        {!loading && collections.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              No collections are configured. Restart the server so the collection foundation is seeded.
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {selected ? `Categories in ${selected.name}` : 'Categories'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Prefixes are unique across every collection — the future category-based SKU segment
                (e.g. {selected?.pricingType === 'fixed' ? 'BAG' : 'RNG'}).
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search categories or prefixes..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
                aria-label="Search categories"
              />
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage={
              query.trim()
                ? 'No categories match your search'
                : 'No categories in this collection yet'
            }
          />

          <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
            <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Existing products keep their current category labels, SKUs and prices. Renaming a category
            relabels the products that use it; it never changes a code or a price.
          </p>
        </CardContent>
      </Card>

      {/* Rename collection */}
      <AppDialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
        size="sm"
        isDirty={renameTarget !== null && renameName !== renameTarget.name}
        title="Rename collection"
        description="The display name changes; the collection's stable ID — and every category in it — stays the same."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={savingRename}>
              Cancel
            </Button>
            <Button onClick={() => void submitRename()} disabled={savingRename || !renameName.trim()}>
              {savingRename ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save name
            </Button>
          </DialogFooter>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="collection-name">Display name</Label>
            <Input
              id="collection-name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder="e.g. Other Products"
              autoFocus
            />
          </div>
          {renameTarget ? (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              Stable ID <span className="font-mono text-foreground">{renameTarget.id}</span> ·{' '}
              {PRICING_LABEL[renameTarget.pricingType] ?? renameTarget.pricingType} pricing
            </p>
          ) : null}
        </div>
      </AppDialog>

      {/* Create / edit category */}
      <AppDialog
        open={categoryDialog !== null}
        onOpenChange={(open) => {
          if (!open) setCategoryDialog(null)
        }}
        size="md"
        title={categoryDialog?.mode === 'edit' ? 'Edit Category' : 'New Category'}
        description={
          categoryDialog?.mode === 'edit'
            ? 'Update the category, its SKU prefix or the collection it belongs to. SKUs and prices already saved are not touched.'
            : 'Add a category to a pricing collection. Its prefix becomes the SKU segment future products mints use.'
        }
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setCategoryDialog(null)} disabled={savingCategory}>
              Cancel
            </Button>
            <Button onClick={() => void submitCategory()} disabled={savingCategory}>
              {savingCategory ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {categoryDialog?.mode === 'edit' ? 'Save changes' : 'Create category'}
            </Button>
          </DialogFooter>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="category-name">Category name</Label>
            <Input
              id="category-name"
              value={categoryForm.name}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder="e.g. Bags"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category-prefix">SKU prefix</Label>
            <Input
              id="category-prefix"
              value={categoryForm.prefix}
              onChange={(e) => {
                setPrefixTouched(true)
                setCategoryForm((f) => ({ ...f, prefix: e.target.value.toUpperCase() }))
              }}
              placeholder="BAG"
              maxLength={5}
              className="font-mono uppercase"
            />
            <p className="text-[11px] text-muted-foreground">2–5 letters, unique across all collections.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category-collection">Collection</Label>
            <Select
              id="category-collection"
              options={collections.map((c) => ({
                value: c.id,
                label: `${c.name} · ${PRICING_LABEL[c.pricingType] ?? c.pricingType}`,
              }))}
              value={categoryForm.collectionId}
              onValueChange={(value) => setCategoryForm((f) => ({ ...f, collectionId: value }))}
              placeholder="Choose a collection"
            />
          </div>
        </div>

        {categoryError ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-sm text-red-700">
            {categoryError}
          </p>
        ) : null}
      </AppDialog>
    </div>
  )
}
