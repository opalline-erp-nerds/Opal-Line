import type { CSSProperties } from 'react'
import { ArrowUpRight, Check, Gem, PlugZap } from 'lucide-react'
import { Link } from 'react-router-dom'
import ringArtwork from '@/assets/hero/ring-5mm.webp'
import type { ShopifyStatus } from '@/types/shopify'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import nightArtwork from '@/assets/hero/night-mode-image.webp'

/**
 * Night Mode banner artwork: the silver solitaire ring on a black, emerald-lit
 * rock. It is handed to CSS as a custom property rather than rendered as an
 * <img> because the 1672x941 source also has its own headline baked into the
 * left half: the ::after layer in index.css is oversized and anchored right so
 * only the jewellery is cropped into the banner, with the live headline kept.
 */
const nightArtworkVars = {
  '--hero-night-art': `url("${nightArtwork}")`,
} as CSSProperties

interface DashboardHeroProps {
  shopifyStatus: ShopifyStatus | null
  lastSyncAt: string | null
  systemHealthy: boolean
}

function latestSync(shopifyStatus: ShopifyStatus | null): string | null {
  if (!shopifyStatus) return null
  return (
    Object.values(shopifyStatus.lastSync ?? {})
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  )
}

function StatusPill({
  icon: Icon,
  label,
  value,
  healthy,
}: {
  icon: typeof Check
  label: string
  value: string
  healthy: boolean
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 py-1.5 pl-2 pr-3 shadow-[0_1px_0_rgba(255,255,255,0.9)_inset] backdrop-blur-sm">
      <span
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full',
          healthy ? 'bg-primary-600 text-white' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-primary-800/60">
          {label}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-[11.5px] font-semibold text-primary-900">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              healthy ? 'bg-success' : 'bg-warning',
            )}
          />
          {value}
        </span>
      </span>
    </span>
  )
}

/**
 * Mint hero banner from the jewellery reference: serif headline, real
 * Shopify/System status pills and the ring artwork. Everything shown is live
 * data - the pills read the same Shopify status the rest of the dashboard uses.
 */
export function DashboardHero({ shopifyStatus, lastSyncAt, systemHealthy }: DashboardHeroProps) {
  const shopifyConnected = Boolean(shopifyStatus?.configured)
  const syncedAt = lastSyncAt ?? latestSync(shopifyStatus)

  return (
    <section
      className="relative isolate overflow-hidden rounded-[26px] border border-primary-100/90 bg-[linear-gradient(112deg,#F8FCFB_0%,#EAF8F3_46%,#D8F1E9_100%)] shadow-card dark:border-border dark:bg-[linear-gradient(112deg,#141F1D_0%,#1B2926_46%,#22332F_100%)]"
      style={nightArtworkVars}
      aria-label="Opal Line overview"
    >
      <svg
        viewBox="0 0 1200 260"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <path d="M0,196 C210,128 372,252 640,196 C842,155 1010,214 1200,168 L1200,260 L0,260 Z" fill="#CFEDE4" opacity="0.55" />
        <path d="M0,220 C262,174 430,252 706,208 C902,178 1062,228 1200,198 L1200,260 L0,260 Z" fill="#B7E5D9" opacity="0.5" />
        <path d="M0,0 H560 C452,58 258,86 0,72 Z" fill="#FFFFFF" opacity="0.45" />
      </svg>
      <div
        className="pointer-events-none absolute -left-16 -top-20 h-56 w-56 rounded-full bg-white/50 blur-3xl"
        aria-hidden="true"
      />
      <img
        src={ringArtwork}
        alt=""
        aria-hidden="true"
        className="hero-artwork-day pointer-events-none absolute right-0 top-0 hidden h-full w-[47%] select-none object-cover object-center sm:block lg:w-[44%]"
        style={{
          maskImage: 'linear-gradient(to right, transparent 0%, black 26%)',
          WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 26%)',
        }}
      />

      <div className="relative z-10 flex min-h-[186px] flex-col justify-between gap-6 px-6 py-6 sm:max-w-[62%] sm:px-8 sm:py-7 lg:px-10">
        <div>
          <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.26em] text-primary-800/65">
            <Gem className="h-3 w-3 text-champagne" />
            Opal Line - Fine Silver
          </p>
          <h2 className="mt-2 font-serif text-[32px] font-medium italic leading-[1.05] text-primary-900 sm:text-[38px] lg:text-[42px]">
            Shine in Every Sale
          </h2>
          <p className="mt-1.5 text-[12.5px] font-medium tracking-wide text-primary-800/70">
            Grow Your Jewellery Business
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <StatusPill
            icon={shopifyConnected ? Check : PlugZap}
            label="Shopify"
            value={shopifyConnected ? 'Connected' : 'Not configured'}
            healthy={shopifyConnected}
          />
          <StatusPill
            icon={systemHealthy ? Check : PlugZap}
            label="System"
            value={systemHealthy ? 'Healthy' : 'Attention'}
            healthy={systemHealthy}
          />
          <Link
            to="/system/settings"
            className="group inline-flex items-center gap-1 rounded-full px-1 text-[11px] font-semibold text-primary-800/70 transition-colors hover:text-primary-900"
          >
            Manage
            <ArrowUpRight className="h-3 w-3 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </Link>
          {syncedAt ? (
            <span className="text-[10.5px] text-primary-800/55">
              Last sync {formatDateTime(syncedAt)}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  )
}
