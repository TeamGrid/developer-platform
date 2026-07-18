import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonObject } from './input.js'

describe('CLI input', () => {
  it('wraps missing input files in a stable local error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-input-'))
    await expect(readJsonObject(`@${join(directory, 'missing.json')}`)).rejects.toMatchObject({
      code: 'invalid_input_file',
      message: 'Could not read the CLI input file.',
    })
  })

  it('rejects non-file and oversized inputs before parsing JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-input-'))
    await expect(readJsonObject(`@${directory}`)).rejects.toMatchObject({
      code: 'invalid_input_file',
    })

    const path = join(directory, 'oversized.json')
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x20))
    await expect(readJsonObject(`@${path}`)).rejects.toMatchObject({ code: 'input_too_large' })
  })

  it('accepts a regular file within the one MiB bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-input-'))
    const path = join(directory, 'input.json')
    await writeFile(path, '{"name":"Production"}')
    await expect(readJsonObject(`@${path}`)).resolves.toEqual({ name: 'Production' })
  })
})
