#!/usr/bin/env node
import { runCli } from './run.js'

const interruption = new AbortController()
const interrupt = () => interruption.abort()
process.once('SIGINT', interrupt)
try {
  process.exitCode = await runCli(process.argv, { signal: interruption.signal })
} finally {
  process.removeListener('SIGINT', interrupt)
}
