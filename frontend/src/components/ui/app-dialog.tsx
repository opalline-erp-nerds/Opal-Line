import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { confirmDialog } from '@/components/ui/confirm'
import { cn } from '@/lib/utils'

/**
 * The app's one dialog component. Use this instead of hand-rolling
 * `<DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">` at each
 * call site — sizing, spacing, mobile insets and scrolling are handled once
 * here and adapt to the content:
 *
 *   - short content (a confirm) → compact, content-sized box
 *   - long content (a form)    → body scrolls while header + footer stay put
 *   - phones                    → inset, rounded, dvh-based max height
 *
 * Title/description live in a fixed header, actions in a fixed footer; only
 * the body scrolls, so Save/Cancel are always reachable.
 *
 * Size presets (width is always min(preset, 95vw); height auto up to 90vh):
 *
 *   sm  ~420px  quick forms (customer, expense, payment, bank account…)
 *   md  ~640px  medium forms (user, quotation basics, detail cards)
 *   lg  ~900px  forms with line items (orders, purchase orders, products)
 *   xl  ~1100px documents (view invoice/order with items, print previews)
 *
 * Pass `isDirty` on forms: Esc, × and click-outside then ask "Discard
 * changes?" before closing. Programmatic closes (Save, parent state resets)
 * bypass the question.
 *
 * ```tsx
 * <AppDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   size="lg"
 *   title="Add Product"
 *   description="Create a product in the billing software."
 *   isDirty={dirty}
 *   footer={<><Button …>Cancel</Button><Button …>Save</Button></>}
 * >
 *   …body…
 * </AppDialog>
 * ```
 */
export interface AppDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** Optional sub-text under the title. */
  description?: ReactNode
  /** Width preset; defaults to `md`. `className` still overrides everything. */
  size?: AppDialogSize
  /** Fixed action bar at the bottom (buttons, validation messages…). Omit for pure display dialogs. */
  footer?: ReactNode
  /** Scrollable body content. */
  children?: ReactNode
  /** Extra node in the title row (icon, status chip…). */
  titleAdornment?: ReactNode
  /** Hide the built-in × (e.g. when a destructive close needs confirming). */
  hideClose?: boolean
  /**
   * The form has unsaved changes. Esc, × and click-outside then ask
   * "Discard changes?" before closing; pressing Save (a programmatic close)
   * never asks.
   */
  isDirty?: boolean
  className?: string
  bodyClassName?: string
  /** Extra classes for the fixed footer bar (e.g. `no-print` in print dialogs). */
  footerClassName?: string
}

/** Width presets: min(preset, 95vw). */
export type AppDialogSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_CLASS: Record<AppDialogSize, string> = {
  sm: 'max-w-[min(95vw,26.25rem)]',
  md: 'max-w-[min(95vw,40rem)]',
  lg: 'max-w-[min(95vw,56.25rem)]',
  xl: 'max-w-[min(95vw,68.75rem)]',
}

/** Width class for a preset. Exported for tests. */
export function appDialogSizeClass(size: AppDialogSize): string {
  return SIZE_CLASS[size]
}

/**
 * Whether a close request must be intercepted with a "Discard changes?" prompt.
 * Opening (`next === true`) and clean forms (`isDirty` falsy) close straight away;
 * only a dirty form being dismissed is guarded. Exported for tests.
 */
export function shouldConfirmDiscard(next: boolean, isDirty?: boolean): boolean {
  return !next && Boolean(isDirty)
}

export function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  footer,
  children,
  titleAdornment,
  hideClose,
  isDirty,
  className,
  bodyClassName,
  footerClassName,
}: AppDialogProps) {
  const handleOpenChange = (next: boolean) => {
    if (!shouldConfirmDiscard(next, isDirty)) {
      onOpenChange(next)
      return
    }
    void confirmDialog({
      title: 'Discard changes?',
      description: 'Your unsaved changes will be lost.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
    }).then((ok) => {
      if (ok) onOpenChange(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        hideClose={hideClose}
        className={cn(
          // flex column with a scrollable middle: header/footer never scroll
          // away, and the p-0/gap-0 overrides neutralise the primitive's
          // padding at both breakpoints (sections carry their own).
          // Height: auto up to 90vh, but never taller than the dvh-based
          // viewport insets on small Electron/mobile windows.
          'flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:gap-0 sm:p-0 sm:max-h-[min(90dvh,calc(100dvh-4rem))]',
          SIZE_CLASS[size],
          className,
        )}
      >
        <DialogHeader className="shrink-0 border-b border-border/60 px-4 pb-3 pt-4 text-left sm:px-6 sm:pt-6">
          <DialogTitle className="flex items-center gap-2 pr-8">
            {titleAdornment}
            {title}
          </DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6', bodyClassName)}>{children}</div>

        {footer ? (
          <div className={cn('shrink-0 border-t border-border/60 px-4 pb-4 pt-3 sm:px-6 sm:pb-6', footerClassName)}>{footer}</div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
