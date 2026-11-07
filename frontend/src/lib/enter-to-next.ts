const SKIP_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

const CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"]'

function isTextInput(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false
  const type = (el.getAttribute('type') ?? 'text').toLowerCase()
  return !SKIP_INPUT_TYPES.has(type)
}

function isFocusableControl(el: Element): el is HTMLElement {
  if (el instanceof HTMLInputElement) return isTextInput(el) && !el.disabled && !el.readOnly
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  if (el instanceof HTMLSelectElement) return !el.disabled
  return el instanceof HTMLElement && el.isContentEditable
}

export function installEnterToNext() {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return

    const target = event.target
    if (!(target instanceof HTMLElement) || !isTextInput(target)) return
    if (!isFocusableControl(target)) return

    const scope = target.closest('[role="dialog"]') ?? target.closest('form')
    if (!scope) return

    const controls = Array.from(scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR))
    const index = controls.indexOf(target)
    if (index === -1) return

    const next = controls
      .slice(index + 1)
      .find((el) => isFocusableControl(el) && el.getClientRects().length > 0)
    if (!next) return

    event.preventDefault()
    next.focus()
  }

  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
}
