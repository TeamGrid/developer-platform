import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { TeamGridClientError } from '@teamgrid/api-client'

export type OutputMode = 'json' | 'jsonl' | 'table'

function scalar(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function rows(value: unknown): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value]
  return items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { value: item }
    const record = item as Record<string, unknown>
    const attributes = record.attributes
    return attributes && typeof attributes === 'object' && !Array.isArray(attributes)
      ? { id: record.id, type: record.type, ...(attributes as Record<string, unknown>) }
      : record
  })
}

export function renderTable(value: unknown) {
  const tableRows = rows(value)
  if (!tableRows.length) return ''
  const columns = Array.from(new Set(tableRows.flatMap((row) => Object.keys(row)))).slice(0, 20)
  const widths = columns.map((column) =>
    Math.min(48, Math.max(column.length, ...tableRows.map((row) => scalar(row[column]).length))),
  )
  const line = (row: Record<string, unknown>) =>
    columns
      .map((column, index) => {
        const width = widths[index] ?? column.length
        return scalar(row[column]).slice(0, width).padEnd(width)
      })
      .join('  ')
      .trimEnd()
  return [
    line(Object.fromEntries(columns.map((column) => [column, column]))),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...tableRows.map(line),
  ].join('\n')
}

export function writeOutput(stream: Writable, value: unknown, mode: OutputMode) {
  if (mode === 'json') {
    stream.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (mode === 'jsonl') {
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) stream.write(`${JSON.stringify(item)}\n`)
    return
  }
  if (mode === 'table') {
    const rendered = renderTable(value)
    if (rendered) stream.write(`${rendered}\n`)
    return
  }
  throw new TeamGridClientError('invalid_output', `Unsupported output mode: ${mode as string}.`)
}

export async function writeJsonLines(stream: Writable, values: readonly unknown[]) {
  for (const value of values) {
    if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, 'drain')
  }
}
