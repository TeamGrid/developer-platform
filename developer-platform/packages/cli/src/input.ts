import { open } from 'node:fs/promises'
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
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(path, 'r')
      const stats = await file.stat()
      if (!stats.isFile()) {
        throw new TeamGridClientError(
          'invalid_input_file',
          'The CLI input path must reference a regular file.',
        )
      }
      if (stats.size > maxInputBytes) {
        throw new TeamGridClientError('input_too_large', 'CLI input must not exceed 1 MiB.')
      }
      const buffer = Buffer.allocUnsafe(maxInputBytes + 1)
      let total = 0
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, null)
        if (bytesRead === 0) break
        total += bytesRead
      }
      if (total > maxInputBytes) {
        throw new TeamGridClientError('input_too_large', 'CLI input must not exceed 1 MiB.')
      }
      text = buffer.subarray(0, total).toString('utf8')
    } catch (error) {
      if (error instanceof TeamGridClientError) throw error
      throw new TeamGridClientError('invalid_input_file', 'Could not read the CLI input file.', {
        cause: error,
      })
    } finally {
      await file?.close().catch(() => undefined)
    }
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
