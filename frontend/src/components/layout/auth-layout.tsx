import { Gem } from 'lucide-react'
import ringArtwork from '@/assets/hero/ring-5mm.webp'

/**
 * Shared shell for every unauthenticated screen (sign in and the forced
 * password change): a deep-teal canvas with a white card that pairs the form
 * with the jewellery artwork, so the first screen matches the dashboard hero.
 */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-sidebar px-4 py-8 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-primary-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 h-[30rem] w-[30rem] rounded-full bg-primary-300/10 blur-3xl" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-champagne/40 to-transparent" />

      <div className="relative z-10 grid w-full max-w-[1080px] overflow-hidden rounded-[28px] border border-white/10 bg-card shadow-popover lg:grid-cols-[1.02fr_0.98fr]">
        <div className="flex flex-col justify-center p-7 sm:p-10 lg:p-12">
          <div className="mx-auto w-full max-w-[400px]">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm ring-1 ring-primary-600/25">
                <Gem className="h-5 w-5" />
              </div>
              <div>
                <p className="font-serif text-[22px] font-semibold leading-none tracking-[0.14em] text-foreground">
                  OPAL LINE
                </p>
                <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-[0.3em] text-primary-600">
                  Jewellery Billing ERP
                </p>
              </div>
            </div>

            <div className="mt-9">{children}</div>

            <div className="mt-8 flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-champagne">
                92.5 Sterling Silver
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <p className="mt-3 text-center text-[10.5px] text-muted-foreground">
              Secure access to billing, inventory and Shopify sync
            </p>
          </div>
        </div>

        <div className="relative hidden min-h-[600px] overflow-hidden lg:block">
          <img
            src={ringArtwork}
            alt="Sterling silver ring on a mint background"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,72,62,0.10)_0%,rgba(0,72,62,0.18)_45%,rgba(0,64,55,0.86)_100%)] dark:bg-[linear-gradient(180deg,rgba(16,24,23,0.12)_0%,rgba(16,24,23,0.28)_45%,rgba(16,24,23,0.82)_100%)]" />
          <div className="absolute inset-x-0 bottom-0 p-10">
            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-champagne">
              Crafted in silver
            </p>
            <p className="mt-3 max-w-[320px] font-serif text-[30px] font-medium italic leading-tight text-white">
              Timeless pieces, priced with precision.
            </p>
            <p className="mt-3 text-[11.5px] leading-relaxed text-white/70">
              Live silver rates, accurate billing and one place for every sale.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Light field styling shared by all auth forms, in both light and dark mode. */
export const authInputClass =
  'h-11 rounded-lg border-border bg-background text-foreground shadow-sm placeholder:text-muted-foreground/70 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/25'

export const authLabelClass = 'text-[13px] font-medium text-foreground/80'
