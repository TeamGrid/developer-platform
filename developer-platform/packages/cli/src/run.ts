import type { Writable } from 'node:stream'
import { TeamGridApiError, TeamGridClientError } from '@teamgrid/api-client'
import { CommanderError } from 'commander'
import { createProgram, exitCodeForError, type ProgramDependencies } from './program.js'

export async function runCli(
  argv = process.argv,
  dependencies: ProgramDependencies & { errorOutput?: Writable } = {},
) {
  const errorOutput = dependencies.errorOutput || process.stderr
  const program = createProgram(dependencies)
  program.exitOverride()
  try {
    await program.parseAsync(argv)
    return 0
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') return 0
    const message =
      error instanceof TeamGridApiError
        ? error.errors[0]?.detail || error.message
        : error instanceof Error
          ? error.message
          : 'Unexpected TeamGrid CLI error.'
    const requestId =
      error instanceof TeamGridApiError && error.requestId ? ` (request ${error.requestId})` : ''
    errorOutput.write(`teamgrid: ${message}${requestId}\n`)
    if (process.env.TEAMGRID_DEBUG === '1' && error instanceof Error) {
      errorOutput.write(`${error.stack || error.message}\n`)
    }
    if (error instanceof CommanderError) return 2
    if (error instanceof TeamGridClientError || error instanceof TeamGridApiError) {
      return exitCodeForError(error)
    }
    return 1
  }
}
