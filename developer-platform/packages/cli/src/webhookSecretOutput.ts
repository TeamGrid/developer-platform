import { open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { TeamGridClientError } from '@teamgrid/api-client'

type SecretReveal = {
  attributes: {
    replayed?: boolean
    revision: string
    signingSecret: string
  }
  id: string
  type: 'webhook' | 'webhookSecretRotation'
}

function validReveal(value: unknown): value is SecretReveal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const resource = value as Record<string, unknown>
  if (
    (resource.type !== 'webhook' && resource.type !== 'webhookSecretRotation') ||
    typeof resource.id !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(resource.id) ||
    !resource.attributes ||
    typeof resource.attributes !== 'object' ||
    Array.isArray(resource.attributes)
  ) {
    return false
  }
  const attributes = resource.attributes as Record<string, unknown>
  return (
    (resource.type === 'webhook' || typeof attributes.replayed === 'boolean') &&
    typeof attributes.revision === 'string' &&
    /^whk1-[a-f0-9]{64}$/.test(attributes.revision) &&
    typeof attributes.signingSecret === 'string' &&
    /^whsec_v2_[A-Za-z0-9_-]{43}$/.test(attributes.signingSecret)
  )
}

async function writeToStream(stream: Writable, value: string) {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.write(value, (error) => (error ? rejectWrite(error) : resolveWrite()))
  })
}

export async function revealWebhookSecret({
  file,
  output,
  rotate,
  stdout,
}: {
  file?: string
  output: Writable & { isTTY?: boolean }
  rotate: () => Promise<unknown>
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
        'Refusing to reveal a webhook signing secret to a terminal. Pipe or redirect stdout.',
      )
    }
    const reveal = await rotate()
    if (!validReveal(reveal)) {
      throw new TeamGridClientError(
        'invalid_api_response',
        'The webhook operation did not contain a valid reveal-only secret.',
      )
    }
    try {
      await writeToStream(output, `${reveal.attributes.signingSecret}\n`)
    } catch (error) {
      throw new TeamGridClientError(
        'invalid_output',
        'Could not write the reveal-only webhook secret to stdout.',
        { cause: error },
      )
    }
    return undefined
  }

  let path: string
  try {
    path = resolve(String(file || ''))
  } catch (error) {
    throw new TeamGridClientError('invalid_output', 'The webhook secret output path is invalid.', {
      cause: error,
    })
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(path, 'wx', 0o600)
    created = true
    const reveal = await rotate()
    if (!validReveal(reveal)) {
      throw new TeamGridClientError(
        'invalid_api_response',
        'The webhook operation did not contain a valid reveal-only secret.',
      )
    }
    await handle.writeFile(`${reveal.attributes.signingSecret}\n`, 'utf8')
    await handle.sync()
    return {
      destination: 'file' as const,
      id: reveal.id,
      path,
      ...(reveal.attributes.replayed === undefined ? {} : { replayed: reveal.attributes.replayed }),
      revision: reveal.attributes.revision,
      type: reveal.type,
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    handle = undefined
    if (created) await unlink(path).catch(() => undefined)
    if (error instanceof TeamGridClientError) throw error
    throw new TeamGridClientError(
      'invalid_output',
      'Could not safely create the webhook secret file; existing files are never overwritten.',
      { cause: error },
    )
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
