import type { Readable, Writable } from 'node:stream'
import { confirm, password } from '@inquirer/prompts'
import {
  normalizeApiBaseUrl,
  parseCredentialLocation,
  TeamGridApiError,
  TeamGridClient,
  TeamGridClientError,
  type TeamGridClientOptions,
} from '@teamgrid/api-client'
import { Command, Option } from 'commander'
import { type CliConfig, ConfigStore, normalizeProfileName } from './config.js'
import { type CredentialStore, SystemCredentialStore } from './credentialStore.js'
import { readJsonObject, readStdin } from './input.js'
import { type OutputMode, writeJsonLines, writeOutput } from './output.js'

type GlobalOptions = {
  baseUrl?: string
  output: OutputMode
  profile?: string
  retries: number
  timeout: number
}

type ListCommandOptions = {
  all?: boolean
  cursor?: string
  limit?: number
  maxPages?: number
}

type CliClient = TeamGridClient

const localUsageErrorCodes = new Set([
  'authentication_required',
  'confirmation_required',
  'input_too_large',
  'invalid_api_domain',
  'invalid_arguments',
  'invalid_base_url',
  'invalid_boolean',
  'invalid_config',
  'invalid_credential',
  'invalid_json',
  'invalid_number',
  'invalid_output',
  'invalid_profile_name',
  'invalid_region',
  'profile_credential_mismatch',
  'unsafe_config_path',
])

export type ProgramDependencies = {
  clientFactory?: (options: TeamGridClientOptions) => CliClient
  configStore?: ConfigStore
  credentialStore?: CredentialStore
  environment?: NodeJS.ProcessEnv
  input?: Readable & { isTTY?: boolean }
  output?: Writable
  promptConfirm?: typeof confirm
  promptPassword?: typeof password
}

function positiveInteger(value: string) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new TeamGridClientError('invalid_number', 'Expected a positive integer.')
  }
  return number
}

function nonNegativeInteger(value: string) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new TeamGridClientError('invalid_number', 'Expected a non-negative integer.')
  }
  return number
}

function booleanValue(value: string) {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new TeamGridClientError('invalid_boolean', 'Expected true or false.')
}

function addListOptions(command: Command) {
  return command
    .option('--all', 'read every page')
    .option('--cursor <cursor>', 'resume from an opaque cursor')
    .option('--limit <number>', 'resources per page (1–200)', positiveInteger)
    .option('--max-pages <number>', 'safety limit for --all', positiveInteger, 10_000)
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions
}

function profileName(command: Command, config: CliConfig) {
  const requested = globalOptions(command).profile
  if (requested) return normalizeProfileName(requested)
  return config.currentProfile || 'default'
}

function publicProfile(name: string, profile: CliConfig['profiles'][string]) {
  return { name, ...profile }
}

function archiveOptions(command: Command) {
  return command.option('-y, --yes', 'skip the archive confirmation')
}

export function createProgram(dependencies: ProgramDependencies = {}) {
  const environment = dependencies.environment || process.env
  const input = dependencies.input || process.stdin
  const output = dependencies.output || process.stdout
  const configStore = dependencies.configStore || new ConfigStore({ environment })
  const credentialStore = dependencies.credentialStore || new SystemCredentialStore()
  const clientFactory = dependencies.clientFactory || ((options) => new TeamGridClient(options))
  const askPassword = dependencies.promptPassword || password
  const askConfirm = dependencies.promptConfirm || confirm
  const program = new Command()

  program
    .name('teamgrid')
    .description('TeamGrid Developer Platform CLI')
    .version('1.0.0-alpha.1')
    .addOption(
      new Option('-o, --output <format>', 'output format')
        .choices(['table', 'json', 'jsonl'])
        .default('table'),
    )
    .option('--profile <name>', 'credential profile')
    .option('--base-url <url>', 'override the regional API v1 base URL')
    .option('--timeout <milliseconds>', 'request timeout', positiveInteger, 30_000)
    .option('--retries <count>', 'safe-request retry count (0–5)', nonNegativeInteger, 2)

  async function loadClient(command: Command) {
    const config = await configStore.load()
    const name = profileName(command, config)
    const profile = config.profiles[name]
    const token =
      String(environment.TEAMGRID_API_TOKEN || '').trim() || (await credentialStore.get(name))
    if (!token) {
      throw new TeamGridClientError(
        'authentication_required',
        `No credential found for profile '${name}'. Run 'teamgrid auth login' or set TEAMGRID_API_TOKEN.`,
      )
    }
    const location = parseCredentialLocation(token)
    if (
      profile &&
      (profile.credentialId !== location.credentialId ||
        profile.cellId !== location.cellId ||
        profile.region !== location.region)
    ) {
      throw new TeamGridClientError(
        'profile_credential_mismatch',
        `The credential stored for profile '${name}' does not match its metadata. Log in again.`,
      )
    }
    const options = globalOptions(command)
    return clientFactory({
      ...(options.baseUrl || profile?.baseUrl
        ? { baseUrl: normalizeApiBaseUrl(options.baseUrl || profile?.baseUrl || '') }
        : {}),
      retries: Math.min(options.retries, 5),
      timeoutMs: options.timeout,
      token,
    })
  }

  function outputData(command: Command, value: unknown) {
    writeOutput(output, value, globalOptions(command).output)
  }

  async function listResources(
    command: Command,
    options: ListCommandOptions & Record<string, unknown>,
    clientMethods: {
      list(value: Record<string, unknown>): Promise<{ data: unknown[]; meta: unknown }>
      pages(
        value: Record<string, unknown>,
        pagination: { maxPages?: number },
      ): AsyncIterable<{ data: unknown[] }>
    },
  ) {
    const { all, maxPages, ...filters } = options
    if (!all) {
      const page = await clientMethods.list(filters)
      outputData(command, globalOptions(command).output === 'table' ? page.data : page)
      return
    }
    if (globalOptions(command).output === 'jsonl') {
      for await (const page of clientMethods.pages(filters, { maxPages })) {
        await writeJsonLines(output, page.data)
      }
      return
    }
    const resources: unknown[] = []
    for await (const page of clientMethods.pages(filters, { maxPages })) {
      resources.push(...page.data)
    }
    outputData(command, resources)
  }

  async function confirmDestructive(
    command: Command,
    action: string,
    resource: string,
    id: string,
  ) {
    const options = command.opts() as { yes?: boolean }
    if (options.yes || environment.TEAMGRID_CLI_ASSUME_YES === '1') return
    if (!input.isTTY) {
      throw new TeamGridClientError(
        'confirmation_required',
        'Use --yes for destructive operations from a non-interactive session.',
      )
    }
    const accepted = await askConfirm({ message: `${action} ${resource} ${id}?`, default: false })
    if (!accepted) throw new TeamGridClientError('cancelled', `${action} cancelled.`)
  }

  const auth = program.command('auth').description('manage local credential profiles')
  auth
    .command('login')
    .description('store a reveal-once API v1 credential in the OS keychain')
    .option('--token-stdin', 'read the credential from standard input')
    .action(async function action(options: { tokenStdin?: boolean }, command: Command) {
      const config = await configStore.load()
      const name = profileName(command, config)
      const token = options.tokenStdin
        ? (await readStdin(input)).trim()
        : await askPassword({ message: 'TeamGrid API v1 credential:', mask: true })
      const location = parseCredentialLocation(token)
      const globals = globalOptions(command)
      const previous = structuredClone(config)
      config.profiles[name] = {
        ...(globals.baseUrl ? { baseUrl: normalizeApiBaseUrl(globals.baseUrl) } : {}),
        ...location,
        createdAt: new Date().toISOString(),
      }
      config.currentProfile = name
      await configStore.save(config)
      try {
        await credentialStore.set(name, token)
      } catch (error) {
        await configStore.save(previous)
        throw error
      }
      const savedProfile = config.profiles[name]
      if (!savedProfile) {
        throw new TeamGridClientError('invalid_config', 'The credential profile was not saved.')
      }
      outputData(command, publicProfile(name, savedProfile))
    })

  auth
    .command('logout')
    .description('remove a profile credential from the OS keychain')
    .action(async function action(_options: unknown, command: Command) {
      const config = await configStore.load()
      const name = profileName(command, config)
      await credentialStore.delete(name)
      delete config.profiles[name]
      if (config.currentProfile === name) {
        config.currentProfile = Object.keys(config.profiles).sort()[0]
      }
      await configStore.save(config)
      outputData(command, { loggedOut: true, profile: name })
    })

  auth
    .command('profiles')
    .description('list non-secret profile metadata')
    .action(async function action(_options: unknown, command: Command) {
      const config = await configStore.load()
      outputData(
        command,
        Object.entries(config.profiles).map(([name, profile]) => ({
          current: config.currentProfile === name,
          ...publicProfile(name, profile),
        })),
      )
    })

  auth
    .command('status')
    .description('show the active credential location and optionally verify it')
    .option('--check', 'call the workspace endpoint')
    .action(async function action(options: { check?: boolean }, command: Command) {
      const config = await configStore.load()
      const name = profileName(command, config)
      const profile = config.profiles[name]
      if (!profile && !environment.TEAMGRID_API_TOKEN) {
        throw new TeamGridClientError(
          'authentication_required',
          `Profile '${name}' is not configured.`,
        )
      }
      if (!options.check) {
        outputData(
          command,
          profile
            ? publicProfile(name, profile)
            : {
                name,
                source: 'TEAMGRID_API_TOKEN',
                ...parseCredentialLocation(environment.TEAMGRID_API_TOKEN || ''),
              },
        )
        return
      }
      const client = await loadClient(command)
      const workspace = await client.workspace.get()
      outputData(command, { profile: name, workspace: workspace.data })
    })

  program
    .command('workspace')
    .description('get the authenticated workspace')
    .action(async function action(_options: unknown, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client.workspace.get()).data)
    })

  const projects = program.command('projects').description('read projects')
  addListOptions(projects.command('list'))
    .option('--archived <boolean>', 'return archived projects', booleanValue)
    .option('--completed <boolean>', 'filter completion', booleanValue)
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.projects as never)
    })
  projects.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.projects.get(id)).data)
  })

  const tasks = program.command('tasks').description('read and mutate tasks')
  addListOptions(tasks.command('list'))
    .option('--archived <boolean>', 'return archived tasks', booleanValue)
    .option('--completed <boolean>', 'filter completion', booleanValue)
    .option('--project-id <id>', 'filter by project')
    .option('--assignee-id <id>', 'filter by assignee')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.tasks as never)
    })
  tasks.command('get <id>').action(async function action(id: string, _options, command: Command) {
    const client = await loadClient(command)
    outputData(command, (await client.tasks.get(id)).data)
  })
  tasks
    .command('create')
    .requiredOption('--data <json|@file|->', 'task create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      const data = await readJsonObject(options.data, input)
      outputData(
        command,
        (
          await client.tasks.create(data as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  tasks
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'task patch JSON')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.tasks.update(id, (await readJsonObject(options.data, input)) as never)).data,
      )
    })
  archiveOptions(tasks.command('archive <id>')).action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Archive', 'task', id)
    const client = await loadClient(command)
    await client.tasks.archive(id)
    outputData(command, { archived: true, id, type: 'task' })
  })

  const times = program
    .command('time-entries')
    .alias('times')
    .description('read and mutate time entries')
  addListOptions(times.command('list'))
    .option('--archived <boolean>', 'return archived time entries', booleanValue)
    .option('--from <date>', 'filter start date')
    .option('--to <date>', 'filter end date')
    .option('--task-id <id>', 'filter by task')
    .option('--user-id <id>', 'filter by user')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.timeEntries as never)
    })
  times.command('get <id>').action(async function action(id: string, _options, command: Command) {
    const client = await loadClient(command)
    outputData(command, (await client.timeEntries.get(id)).data)
  })
  times
    .command('create')
    .requiredOption('--data <json|@file|->', 'time-entry create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.timeEntries.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  times
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'time-entry patch JSON')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.timeEntries.update(id, (await readJsonObject(options.data, input)) as never))
          .data,
      )
    })
  archiveOptions(times.command('archive <id>')).action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Archive', 'time entry', id)
    const client = await loadClient(command)
    await client.timeEntries.archive(id)
    outputData(command, { archived: true, id, type: 'timeEntry' })
  })

  const contacts = program.command('contacts').description('read contacts')
  addListOptions(contacts.command('list'))
    .option('--archived <boolean>', 'return archived contacts', booleanValue)
    .addOption(new Option('--type <type>', 'contact type').choices(['person', 'company']))
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.contacts as never)
    })
  contacts.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.contacts.get(id)).data)
  })

  for (const resource of ['users', 'lists', 'services', 'tags'] as const) {
    const command = addListOptions(program.command(resource).description(`list ${resource}`))
    if (resource !== 'users')
      command.option('--archived <boolean>', 'return archived values', booleanValue)
    if (resource === 'lists') command.option('--type <type>', 'filter task-list type')
    command.action(async function action(options, currentCommand: Command) {
      const client = await loadClient(currentCommand)
      await listResources(currentCommand, options, client[resource] as never)
    })
  }

  addListOptions(
    program.command('audit-events').description('list Developer Platform audit events'),
  )
    .option('--credential-id <id>', 'filter by credential')
    .option('--event-type <type>', 'filter by event type')
    .addOption(
      new Option('--outcome <outcome>', 'filter outcome').choices(['success', 'denied', 'failure']),
    )
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.auditEvents as never)
    })

  const webhooks = program.command('webhooks').description('read and manage webhooks')
  addListOptions(webhooks.command('list')).action(async function action(options, command: Command) {
    const client = await loadClient(command)
    await listResources(command, options, client.webhooks as never)
  })
  webhooks.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.webhooks.get(id)).data)
  })
  webhooks
    .command('create')
    .requiredOption('--data <json|@file|->', 'webhook create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.webhooks.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  archiveOptions(webhooks.command('remove <id>')).action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Remove', 'webhook', id)
    const client = await loadClient(command)
    await client.webhooks.remove(id)
    outputData(command, { id, removed: true, type: 'webhook' })
  })

  return program
}

export function exitCodeForError(error: unknown) {
  if (error instanceof TeamGridApiError) {
    return ({ 401: 3, 403: 4, 404: 5, 409: 6, 429: 7 } as Record<number, number>)[error.status] || 1
  }
  if (error instanceof TeamGridClientError) {
    if (error.code === 'cancelled') return 0
    return localUsageErrorCodes.has(error.code) ? 2 : 1
  }
  return 1
}
