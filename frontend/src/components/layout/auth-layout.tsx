import { useState } from 'react'
import { Gem } from 'lucide-react'
import heroImage from '@/assets/login-hero.webp'
import { cn } from '@/lib/utils'

/**
 * Shared shell for every unauthenticated screen (sign in and the forced
 * password change). The photo is bundled through Vite so the desktop app keeps
 * working offline; the solid warm background shows until the image decodes.
 */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  const [imageLoaded, setImageLoaded] = useState(false)

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#15110d] text-white">
      <link rel="preload" as="image" href={heroImage} />
      <img
        src={heroImage}
        alt=""
        aria-hidden="true"
        fetchPriority="high"
        decoding="async"
        onLoad={() => setImageLoaded(true)}
        className={cn(
          'pointer-events-none absolute inset-0 h-full w-full object-cover object-right transition-opacity duration-700',
          imageLoaded ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Phones get an even dim so the translucent panel stays readable. */}
      <div className="pointer-events-none absolute inset-0 bg-[#15110d]/75 md:hidden" />

      {/* Desktop keeps the women on the right clear and darkens the form side. */}
      <div
        className="pointer-events-none absolute inset-0 hidden md:block"
        style={{
          background:
            'linear-gradient(90deg, rgba(21,17,13,0.9) 0%, rgba(21,17,13,0.7) 30%, rgba(21,17,13,0.3) 60%, rgba(21,17,13,0) 100%)',
        }}
      />

      {/* Subtle top gradient and blur for a premium feel, visible only on desktop. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-20 md:hidden"
        style={{
          background:
            'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.1) 50%, rgba(0,0,0,0.2) 100%)',
          backdropFilter: 'blur(4px)',
        }}
      />

      <div className="relative z-10 flex min-h-screen items-center px-5 py-10 sm:px-8 md:px-[8vw] lg:px-[10vw]">
        <div className="mx-auto w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#17120d]/80 p-6 shadow-2xl shadow-black/40 backdrop-blur-md sm:p-8 md:mx-0 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none md:backdrop-blur-none">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gold text-gold-foreground shadow-lg shadow-black/30 ring-1 ring-white/20">
              <Gem className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[15px] font-semibold tracking-[0.22em] text-white">OPAL LINE</p>
              <p className="mt-1 text-[9px] font-semibold uppercase tracking-[0.3em] text-[#d8b36a]">
                Jewellery Billing ERP
              </p>
            </div>
          </div>

          <div className="mt-8">{children}</div>

          <p className="mt-6 text-[11px] font-medium tracking-[0.08em] text-[#bdae99]">
            92.5 Sterling Silver · Ecommerce ERP
          </p>
        </div>
      </div>

      <div className="absolute bottom-10 right-10 hidden text-right md:block lg:bottom-12 lg:right-12">
        <p className="text-lg font-bold text-white [text-shadow:0_2px_12px_rgba(0,0,0,0.65)]">Pure 92.5 Silver</p>
        <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.3em] text-white/75 [text-shadow:0_2px_10px_rgba(0,0,0,0.6)]">
          Elegance that lasts forever
        </p>
      </div>
    </div>
  )
}

/** Pale field styling shared by all auth forms, in both light and dark mode. */
export const authInputClass =
  'h-11 rounded-lg border-[#cbbca4] bg-[#f7f2e9] text-[#231c14] shadow-sm placeholder:text-[#7a6d5c] focus-visible:border-[#b8903f] focus-visible:ring-2 focus-visible:ring-[#c9a24a]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#15110d]'

export const authLabelClass = 'text-[13px] font-medium text-[#efe6d6]'