import { open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { TeamGridClientError } from '@teamgrid/api-client'

export const maximumCliExportBytes = 50 * 1024 * 1024

export type CliExportDownload = {
  contentType?: string
  data: Uint8Array
  fileName?: string
}

function downloadBytes(download: CliExportDownload, maximumBytes: number) {
  if (!(download.data instanceof Uint8Array)) {
    throw new TeamGridClientError(
      'invalid_api_response',
      'The export download did not contain binary data.',
    )
  }
  if (download.data.byteLength > maximumBytes) {
    throw new TeamGridClientError(
      'invalid_api_response',
      `The export download exceeded the ${maximumBytes}-byte safety limit.`,
    )
  }
  return Buffer.from(download.data.buffer, download.data.byteOffset, download.data.byteLength)
}

async function writeToStream(stream: Writable, bytes: Buffer) {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.write(bytes, (error) => (error ? rejectWrite(error) : resolveWrite()))
  })
}

export async function writeExportDownload({
  download,
  file,
  maximumBytes = maximumCliExportBytes,
  output,
  stdout,
}: {
  download: CliExportDownload
  file?: string
  maximumBytes?: number
  output: Writable & { isTTY?: boolean }
  stdout?: boolean
}) {
  if (Boolean(file) === Boolean(stdout)) {
    throw new TeamGridClientError(
      'invalid_arguments',
      'Choose exactly one export destination: --file or --stdout.',
    )
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > maximumCliExportBytes
  ) {
    throw new TeamGridClientError(
      'invalid_number',
      `Maximum export bytes must be an integer from 1 to ${maximumCliExportBytes}.`,
    )
  }
  const bytes = downloadBytes(download, maximumBytes)
  if (stdout) {
    if (output.isTTY) {
      throw new TeamGridClientError(
        'invalid_output',
        'Refusing to write export bytes to a terminal. Redirect stdout to a file or pipe.',
      )
    }
    try {
      await writeToStream(output, bytes)
    } catch (error) {
      throw new TeamGridClientError('invalid_output', 'Could not write the export to stdout.', {
        cause: error,
      })
    }
    return { bytes: bytes.byteLength, destination: 'stdout' as const }
  }

  let path: string
  try {
    path = resolve(String(file || ''))
  } catch (error) {
    throw new TeamGridClientError('invalid_output', 'The export output path is invalid.', {
      cause: error,
    })
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(path, 'wx', 0o600)
    created = true
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    if (created) await unlink(path).catch(() => undefined)
    throw new TeamGridClientError(
      'invalid_output',
      'Could not safely create the export output file; existing files are never overwritten.',
      { cause: error },
    )
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return { bytes: bytes.byteLength, destination: 'file' as const, path }
}
