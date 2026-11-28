import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeProductDescription } from './sanitizeHtml'

test('product descriptions keep safe formatting but drop scripts, handlers and unsafe URLs', () => {
  const dirty = [
    '<p>Hello <strong>silver</strong></p>',
    '<ul><li>HUID: 925</li></ul>',
    '<script>window.__xss = 1</script>',
    '<img src=x onerror="window.__xss = 2">',
    '<a href="javascript:alert(3)" onclick="alert(4)">bad link</a>',
  ].join('')

  const clean = sanitizeProductDescription(dirty)

  assert.ok(clean.includes('<p>Hello <strong>silver</strong></p>'), 'paragraph and bold survive')
  assert.ok(clean.includes('<ul><li>HUID: 925</li></ul>'), 'list formatting survives')
  assert.ok(!/script/i.test(clean), 'script element and its body are removed')
  assert.ok(!/img|onerror/i.test(clean), 'image tag and event handler are removed')
  assert.ok(!/javascript:|onclick/i.test(clean), 'javascript URL and click handler are removed')
  assert.ok(clean.includes('bad link'), 'the link text remains as inert text')
})

test('safe links and escaped text survive sanitization', () => {
  const clean = sanitizeProductDescription(
    '<p>See <a href="https://example.com/policy">terms</a> &amp; <em>notes</em></p>',
  )
  assert.ok(clean.includes('<a href="https://example.com/policy">terms</a>'))
  assert.ok(clean.includes('&amp;'))
  assert.ok(clean.includes('<em>notes</em>'))
})
