import { parseDocument } from 'htmlparser2'

/**
 * Strict allowlist sanitiser for product descriptions rendered with
 * `dangerouslySetInnerHTML`. Descriptions come from Shopify syncs and admin
 * edits, so they are untrusted HTML: only inert formatting is kept, and every
 * attribute except a safe link `href` is discarded.
 */

type SanitizableNode = {
  type: string
  name?: string
  attribs?: Record<string, string>
  data?: string
  children?: SanitizableNode[]
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u',
  'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a',
])
const VOID_TAGS = new Set(['br'])
// These carry active content or embedded resources: drop them AND their text.
const DROP_ENTIRELY = new Set([
  'script', 'style', 'img', 'iframe', 'object', 'embed', 'svg', 'math',
  'form', 'input', 'button', 'textarea', 'select', 'option',
  'video', 'audio', 'source', 'track', 'canvas',
  'link', 'meta', 'base', 'template', 'noscript',
  'html', 'head', 'body', 'title',
])

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

function safeHref(value: string | undefined): string | null {
  if (!value) return null
  // Strip control characters so `java\nscript:` and `java\tscript:` cannot
  // slip past the scheme check (browsers ignore them when resolving URLs).
  let href = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) href += char
  }
  href = href.trim()
  if (!href) return null
  if (/^(?:javascript|data|vbscript|file):/i.test(href)) return null
  // Any other explicit scheme (including obfuscated entity-decoded ones) is
  // refused; relative paths, fragments and //host URLs are scheme-free.
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^(?:https?|mailto):/i.test(href)) return null
  return href
}

function serialize(node: SanitizableNode): string {
  if (node.type === 'text' || node.type === 'cdata') return escapeText(node.data ?? '')
  // Comments and processing instructions never carry display content.
  if (node.type === 'comment' || node.type === 'directive') return ''
  const tag = (node.name ?? '').toLowerCase()
  if (node.type === 'script' || node.type === 'style' || DROP_ENTIRELY.has(tag)) return ''

  const children = (node.children ?? []).map(serialize).join('')
  if (VOID_TAGS.has(tag)) return `<${tag}>`
  // Unknown but inert tags are unwrapped: keep their text, drop the element.
  if (!ALLOWED_TAGS.has(tag)) return children

  if (tag === 'a') {
    const href = safeHref(node.attribs?.href)
    // An unsafe link becomes plain text rather than an anchor.
    if (!href) return children
    return `<a href="${escapeAttribute(href)}">${children}</a>`
  }
  return `<${tag}>${children}</${tag}>`
}

export function sanitizeProductDescription(raw: string | null | undefined): string {
  if (!raw) return ''
  const document = parseDocument(raw, { decodeEntities: true })
  return (document.children as unknown as SanitizableNode[]).map(serialize).join('').trim()
}
