import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TeamGridClientError } from '@teamgrid/api-client'

const maxInputBytes = 1024 * 1024

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > maxInputBytes) {
      throw new TeamGridClientError('input_too_large', 'CLI input must not exceed 1 MiB.')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJsonObject(source: string, stdin: NodeJS.ReadableStream = process.stdin) {
  let text: string
  if (source === '-') text = await readStdin(stdin)
  else if (source.startsWith('@')) {
    const path = resolve(source.slice(1))
    const file = await readFile(path)
    if (file.length > maxInputBytes) {
      throw new TeamGridClientError('input_too_large', 'CLI input must not exceed 1 MiB.')
    }
    text = file.toString('utf8')
  } else text = source

  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected an object.')
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new TeamGridClientError('invalid_json', 'Expected a valid JSON object.', { cause: error })
  }
}
