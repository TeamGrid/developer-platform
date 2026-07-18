import { describe, expect, it } from 'vitest'
import { renderTable, sanitizeTerminalText } from './output.js'

function containsUnsafeTerminalCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return (
      (codePoint !== 0x0a && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    )
  })
}

describe('CLI table output', () => {
  it('renders terminal control and bidirectional characters visibly', () => {
    const table = renderTable({
      alm: '\u061c',
      ansi: 'before\u001b[31mred\u0007\nafter',
      bidiOverride: '\u202e',
      leftToRightMark: '\u200e',
      nested: { value: 'tab\tvalue\u2066' },
      rightToLeftMark: '\u200f',
    })
    expect(containsUnsafeTerminalCharacter(table)).toBe(false)
    expect(table).toContain('\\u001b[31m')
    expect(table).toContain('\\u0007')
    expect(table).toContain('\\n')
    expect(table).toContain('\\u061c')
    expect(table).toContain('\\u200e')
    expect(table).toContain('\\u200f')
    expect(table).toContain('\\u202e')
    expect(table).toContain('\\t')
    expect(table).toContain('\\u2066')
  })

  it('can preserve only formatter-owned line feeds', () => {
    expect(sanitizeTerminalText('line 1\nline 2\r\u001b', true)).toBe('line 1\nline 2\\r\\u001b')
  })
})
