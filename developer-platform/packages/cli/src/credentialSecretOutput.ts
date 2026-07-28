import { open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { TeamGridClientError } from '@teamgrid/api-client'

type CredentialReveal = {
  attributes: {
    generation: number
    principalId: string
    token: string
  }
  id: string
  type: 'personalAccessToken' | 'serviceAccountCredential'
}

function validReveal(value: unknown): value is CredentialReveal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const resource = value as Record<string, unknown>
  if (
    !['personalAccessToken', 'serviceAccountCredential'].includes(String(resource.type)) ||
    typeof resource.id !== 'string' ||
    !/^[a-f0-9]{24}$/.test(resource.id) ||
    !resource.attributes ||
    typeof resource.attributes !== 'object' ||
    Array.isArray(resource.attributes)
  )
    return false
  const attributes = resource.attributes as Record<string, unknown>
  const prefix = resource.type === 'personalAccessToken' ? 'pat' : 'sa'
  return (
    Number.isSafeInteger(attributes.generation) &&
    (attributes.generation as number) >= 1 &&
    typeof attributes.principalId === 'string' &&
    typeof attributes.token === 'string' &&
    new RegExp(`^tg_${prefix}_v2_[a-z0-9-]+_[a-z0-9-]+_[a-f0-9]{24}_[a-f0-9]{64}$`).test(
      attributes.token,
    )
  )
}

async function writeToStream(stream: Writable, value: string) {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.write(value, (error) => (error ? rejectWrite(error) : resolveWrite()))
  })
}

export async function revealCredentialSecret({
  file,
  issue,
  output,
  stdout,
}: {
  file?: string
  issue: () => Promise<unknown>
  output: Writable & { isTTY?: boolean }
  stdout?: boolean
}) {
  if (Boolean(file) === Boolean(stdout)) {
    throw new TeamGridClientError(
      'invalid_arguments',
      'Choose exactly one reveal-only destination: --secret-file or --secret-stdout.',
    )
  }
  if (stdout) {
    if (output.isTTY) {
      throw new TeamGridClientError(
        'invalid_output',
        'Refusing to reveal a credential to a terminal. Pipe or redirect stdout.',
      )
    }
    const reveal = await issue()
    if (!validReveal(reveal)) {
      throw new TeamGridClientError(
        'invalid_api_response',
        'The credential operation did not return a valid reveal-once token.',
      )
    }
    try {
      await writeToStream(output, `${reveal.attributes.token}\n`)
    } catch (error) {
      throw new TeamGridClientError(
        'invalid_output',
        'Could not write the reveal-once credential to stdout.',
        { cause: error },
      )
    }
    return undefined
  }

  const path = resolve(String(file || ''))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(path, 'wx', 0o600)
    created = true
    const reveal = await issue()
    if (!validReveal(reveal)) {
      throw new TeamGridClientError(
        'invalid_api_response',
        'The credential operation did not return a valid reveal-once token.',
      )
    }
    await handle.writeFile(`${reveal.attributes.token}\n`, 'utf8')
    await handle.sync()
    return {
      destination: 'file' as const,
      generation: reveal.attributes.generation,
      id: reveal.id,
      path,
      principalId: reveal.attributes.principalId,
      type: reveal.type,
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    handle = undefined
    if (created) await unlink(path).catch(() => undefined)
    if (error instanceof TeamGridClientError) throw error
    throw new TeamGridClientError(
      'invalid_output',
      'Could not safely create the credential file; existing files are never overwritten.',
      { cause: error },
    )
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
