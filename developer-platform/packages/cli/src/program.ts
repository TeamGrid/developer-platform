import { createRequire } from 'node:module'
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
import { type OutputMode, sanitizeTerminalText, writeJsonLines, writeOutput } from './output.js'

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

type ChangeCommandOptions = ListCommandOptions & {
  operation?: string[]
  resourceType?: string[]
}

type CliClient = TeamGridClient

const localUsageErrorCodes = new Set([
  'authentication_required',
  'confirmation_required',
  'input_too_large',
  'insecure_base_url',
  'invalid_api_domain',
  'invalid_arguments',
  'invalid_base_url',
  'invalid_boolean',
  'invalid_config',
  'invalid_credential',
  'invalid_input_file',
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
  errorOutput?: Writable
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

function integerInRange(minimum: number, maximum: number, description: string) {
  return (value: string) => {
    const number = Number(value)
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      throw new TeamGridClientError(
        'invalid_number',
        `${description} must be an integer from ${minimum} to ${maximum}.`,
      )
    }
    return number
  }
}

function booleanValue(value: string) {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new TeamGridClientError('invalid_boolean', 'Expected true or false.')
}

function commaSeparatedChoice(
  allowed: ReadonlySet<string>,
  description: string,
): (value: string, previous: string[]) => string[] {
  return (value, previous = []) => {
    const values = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (!values.length || values.some((item) => !allowed.has(item))) {
      throw new TeamGridClientError(
        'invalid_arguments',
        `${description} must contain only: ${Array.from(allowed).join(', ')}.`,
      )
    }
    return Array.from(new Set([...previous, ...values]))
  }
}

function addListOptions(command: Command) {
  return command
    .option('--all', 'read every page')
    .option('--cursor <cursor>', 'resume from an opaque cursor')
    .option('--limit <number>', 'resources per page (1–200)', integerInRange(1, 200, 'Limit'))
    .option(
      '--max-pages <number>',
      'safety limit for --all (1–10000)',
      integerInRange(1, 10_000, 'Maximum pages'),
      10_000,
    )
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

function lifecycleOptions(command: Command) {
  return command
    .option('--idempotency-key <key>', 'stable retry key')
    .option('--wait', 'wait until the asynchronous operation finishes')
    .option('--poll-interval <milliseconds>', 'poll interval while waiting', positiveInteger, 1000)
    .option('--max-wait <milliseconds>', 'maximum wait time', positiveInteger, 300_000)
}

export function createProgram(dependencies: ProgramDependencies = {}) {
  const environment = dependencies.environment || process.env
  const input = dependencies.input || process.stdin
  const output = dependencies.output || process.stdout
  const errorOutput = dependencies.errorOutput || process.stderr
  const configStore = dependencies.configStore || new ConfigStore({ environment })
  const credentialStore = dependencies.credentialStore || new SystemCredentialStore()
  const clientFactory = dependencies.clientFactory || ((options) => new TeamGridClient(options))
  const askPassword = dependencies.promptPassword || password
  const askConfirm = dependencies.promptConfirm || confirm
  const program = new Command()
  const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string })
    .version

  program.configureOutput({
    writeErr: (value) => {
      errorOutput.write(sanitizeTerminalText(value, true))
    },
    writeOut: (value) => {
      output.write(value)
    },
  })

  program
    .name('teamgrid')
    .description('TeamGrid Developer Platform CLI')
    .version(packageVersion)
    .addOption(
      new Option('-o, --output <format>', 'output format')
        .choices(['table', 'json', 'jsonl'])
        .default('table'),
    )
    .option('--profile <name>', 'credential profile')
    .option('--base-url <url>', 'override the regional API v1 base URL')
    .option('--timeout <milliseconds>', 'request timeout', positiveInteger, 30_000)
    .option(
      '--retries <count>',
      'safe-request retry count (0–5)',
      integerInRange(0, 5, 'Retry count'),
      2,
    )

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
      retries: options.retries,
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

  const changeOperations = new Set(['created', 'deleted', 'updated'])
  const changeResourceTypes = new Set([
    'callNote',
    'contact',
    'contactGroup',
    'customFieldDefinition',
    'list',
    'product',
    'productGroup',
    'project',
    'projectStatement',
    'service',
    'tag',
    'task',
    'timeEntry',
  ])

  function addChangeFilterOptions(command: Command) {
    return command
      .option(
        '--operation <operation>',
        'filter operation; repeat or comma-separate',
        commaSeparatedChoice(changeOperations, 'Operation'),
        [],
      )
      .option(
        '--resource-type <type>',
        'filter resource type; repeat or comma-separate',
        commaSeparatedChoice(changeResourceTypes, 'Resource type'),
        [],
      )
  }

  function changeFilters(options: ChangeCommandOptions) {
    return {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.operation?.length ? { operations: options.operation } : {}),
      ...(options.resourceType?.length ? { resourceTypes: options.resourceType } : {}),
    }
  }

  async function outputChangePage(
    command: Command,
    page: {
      data: unknown[]
      meta: { page: { caughtUp: boolean; nextCursor: string }; requestId: string }
    },
  ) {
    const mode = globalOptions(command).output
    if (mode === 'json') {
      outputData(command, page)
      return
    }
    if (mode === 'jsonl') {
      await writeJsonLines(
        output,
        page.data.map((data) => ({ data, kind: 'change' })),
      )
      await writeJsonLines(output, [
        {
          caughtUp: page.meta.page.caughtUp,
          cursor: page.meta.page.nextCursor,
          kind: 'checkpoint',
          requestId: page.meta.requestId,
        },
      ])
      return
    }
    outputData(command, page.data)
    outputData(command, {
      caughtUp: page.meta.page.caughtUp,
      cursor: page.meta.page.nextCursor,
      requestId: page.meta.requestId,
      type: 'changeCheckpoint',
    })
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
    const accepted = await askConfirm({
      message: `${action} ${resource} ${sanitizeTerminalText(id)}?`,
      default: false,
    })
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
    .command('api-version')
    .description('discover the TeamGrid API version')
    .action(async function action(_options: unknown, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client.system.getApiVersion()).data)
    })

  program
    .command('workspace')
    .description('get the authenticated workspace')
    .action(async function action(_options: unknown, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client.workspace.get()).data)
    })

  const projects = program.command('projects').description('read and mutate projects')
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
  projects
    .command('create')
    .requiredOption('--data <json|@file|->', 'project create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.projects.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  projects
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'project patch JSON')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.projects.update(id, (await readJsonObject(options.data, input)) as never))
          .data,
      )
    })
  async function runProjectLifecycle(
    action: 'archive' | 'complete' | 'reopen' | 'restore',
    id: string,
    options: {
      idempotencyKey?: string
      maxWait?: number
      pollInterval?: number
      wait?: boolean
    },
    command: Command,
  ) {
    const client = await loadClient(command)
    const started = await client.projects[action](id, {
      idempotencyKey: options.idempotencyKey,
    })
    const result = options.wait
      ? await client.projectLifecycleOperations.wait(started.data.id, {
          maxWaitMs: options.maxWait,
          pollIntervalMs: options.pollInterval,
        })
      : started
    outputData(command, result.data)
  }
  lifecycleOptions(projects.command('complete <id>')).action(async function action(
    id: string,
    options,
    command: Command,
  ) {
    await runProjectLifecycle('complete', id, options, command)
  })
  lifecycleOptions(projects.command('reopen <id>')).action(async function action(
    id: string,
    options,
    command: Command,
  ) {
    await runProjectLifecycle('reopen', id, options, command)
  })
  lifecycleOptions(projects.command('restore <id>')).action(async function action(
    id: string,
    options,
    command: Command,
  ) {
    await runProjectLifecycle('restore', id, options, command)
  })
  lifecycleOptions(archiveOptions(projects.command('archive <id>'))).action(async function action(
    id: string,
    options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Archive', 'project', id)
    await runProjectLifecycle('archive', id, options, command)
  })

  const projectLifecycleOperations = program
    .command('project-lifecycle-operations')
    .description('inspect asynchronous project lifecycle operations')
  projectLifecycleOperations.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.projectLifecycleOperations.get(id)).data)
  })

  function registerCommerceCommands(
    resource: 'product-groups' | 'products' | 'project-statements',
    singular: 'product group' | 'product' | 'project statement',
    clientResource: 'productGroups' | 'products' | 'projectStatements',
  ) {
    const root = program.command(resource).description(`read and manage ${resource}`)
    const list = addListOptions(root.command('list')).option(
      '--archived <boolean>',
      `return archived ${resource}`,
      booleanValue,
    )
    if (resource === 'products') {
      list
        .option('--disabled <boolean>', 'filter disabled products', booleanValue)
        .option('--product-group-id <id>', 'filter by product group')
    } else if (resource === 'product-groups') {
      list.option('--parent-id <id>', 'filter by parent product group')
    } else {
      list
        .option('--created-at-from <date>', 'filter by earliest creation timestamp')
        .option('--created-at-to <date>', 'filter by latest creation timestamp')
        .option('--created-by <id>', 'filter by creator')
        .option('--date-from <date>', 'filter by earliest statement date')
        .option('--date-to <date>', 'filter by latest statement date')
        .option('--product-id <id>', 'filter by product')
        .option('--project-id <id>', 'filter by project')
        .addOption(
          new Option('--type <type>', 'filter statement type').choices([
            'budget',
            'bundle',
            'manual',
            'product',
          ]),
        )
    }
    list.action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client[clientResource] as never)
    })
    root.command('get <id>').action(async function action(id: string, _options, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client[clientResource].get(id)).data)
    })
    root
      .command('create')
      .requiredOption('--data <json|@file|->', `${singular} create JSON`)
      .option('--idempotency-key <key>', 'stable retry key')
      .action(async function action(options, command: Command) {
        const client = await loadClient(command)
        outputData(
          command,
          (
            await client[clientResource].create(
              (await readJsonObject(options.data, input)) as never,
              { idempotencyKey: options.idempotencyKey },
            )
          ).data,
        )
      })
    root
      .command('update <id>')
      .requiredOption('--data <json|@file|->', `${singular} patch JSON`)
      .action(async function action(id: string, options, command: Command) {
        const client = await loadClient(command)
        outputData(
          command,
          (
            await client[clientResource].update(
              id,
              (await readJsonObject(options.data, input)) as never,
            )
          ).data,
        )
      })
    archiveOptions(root.command('archive <id>')).action(async function action(
      id: string,
      _options,
      command: Command,
    ) {
      await confirmDestructive(command, 'Archive', singular, id)
      const client = await loadClient(command)
      await client[clientResource].archive(id)
      outputData(command, {
        archived: true,
        id,
        type:
          clientResource === 'productGroups'
            ? 'productGroup'
            : clientResource === 'projectStatements'
              ? 'projectStatement'
              : 'product',
      })
    })
    if (clientResource === 'projectStatements') {
      root.command('restore <id>').action(async function action(
        id: string,
        _options,
        command: Command,
      ) {
        const client = await loadClient(command)
        outputData(command, (await client.projectStatements.restore(id)).data)
      })
    }
  }

  registerCommerceCommands('products', 'product', 'products')
  registerCommerceCommands('product-groups', 'product group', 'productGroups')
  registerCommerceCommands('project-statements', 'project statement', 'projectStatements')

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
  tasks.command('complete <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.tasks.complete(id)).data)
  })
  tasks.command('restore <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.tasks.restore(id)).data)
  })
  tasks.command('reopen <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.tasks.reopen(id)).data)
  })
  const taskTimer = tasks.command('timer').description('start or stop task time tracking')
  taskTimer
    .command('start <id>')
    .requiredOption('--user-id <id>', 'workspace user whose timer should start')
    .option('--at <date>', 'start timestamp; defaults to the API receive time')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.tasks.startTimer(id, {
            ...(options.at ? { at: options.at } : {}),
            userId: options.userId,
          })
        ).data,
      )
    })
  taskTimer
    .command('stop <id>')
    .requiredOption('--user-id <id>', 'workspace user whose timer should stop')
    .option('--at <date>', 'stop timestamp; defaults to the API receive time')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.tasks.stopTimer(id, {
            ...(options.at ? { at: options.at } : {}),
            userId: options.userId,
          })
        ).data,
      )
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
  times.command('restore <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.timeEntries.restore(id)).data)
  })

  const callNotes = program.command('call-notes').description('read and manage call notes')
  addListOptions(callNotes.command('list'))
    .option('--archived <boolean>', 'return archived call notes', booleanValue)
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.callNotes as never)
    })
  callNotes.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.callNotes.get(id)).data)
  })
  callNotes
    .command('create')
    .requiredOption('--data <json|@file|->', 'call-note create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.callNotes.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  archiveOptions(callNotes.command('archive <id>')).action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Archive', 'call note', id)
    const client = await loadClient(command)
    await client.callNotes.archive(id)
    outputData(command, { archived: true, id, type: 'callNote' })
  })
  callNotes.command('restore <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.callNotes.restore(id)).data)
  })

  const contacts = program.command('contacts').description('read and mutate contacts')
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
  contacts
    .command('create')
    .requiredOption('--data <json|@file|->', 'contact create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.contacts.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  contacts
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'contact patch JSON')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.contacts.update(id, (await readJsonObject(options.data, input)) as never))
          .data,
      )
    })

  const contactGroups = program
    .command('contact-groups')
    .description('read and manage contact groups')
  addListOptions(contactGroups.command('list'))
    .option('--archived <boolean>', 'return archived contact groups', booleanValue)
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.contactGroups as never)
    })
  contactGroups.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.contactGroups.get(id)).data)
  })
  contactGroups
    .command('create')
    .requiredOption('--data <json|@file|->', 'contact-group create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.contactGroups.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  contactGroups
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'contact-group patch JSON')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.contactGroups.update(
            id,
            (await readJsonObject(options.data, input)) as never,
          )
        ).data,
      )
    })
  archiveOptions(contactGroups.command('archive <id>')).action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Archive', 'contact group', id)
    const client = await loadClient(command)
    await client.contactGroups.archive(id)
    outputData(command, { archived: true, id, type: 'contactGroup' })
  })
  contactGroups.command('restore <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.contactGroups.restore(id)).data)
  })

  addListOptions(program.command('users').description('list workspace users')).action(
    async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.users as never)
    },
  )

  function registerMetadataCommands(
    resource: 'lists' | 'services' | 'tags',
    singular: 'list' | 'service' | 'tag',
  ) {
    function addMetadataListOptions(command: Command) {
      addListOptions(command).option('--archived <boolean>', 'return archived values', booleanValue)
      if (resource === 'lists') {
        command
          .option('--parent-id <id>', 'filter by parent project or user')
          .addOption(
            new Option('--type <type>', 'list type').choices(['tasks', 'projects', 'personal']),
          )
      }
      return command
    }

    async function runList(
      options: ListCommandOptions & Record<string, unknown>,
      command: Command,
    ) {
      const client = await loadClient(command)
      const parentOptions = command.parent?.name() === resource ? command.parent.opts() : {}
      await listResources(command, { ...parentOptions, ...options }, client[resource] as never)
    }

    const root = addMetadataListOptions(
      program.command(resource).description(`read and manage ${resource}`),
    )
    root.action(runList)
    addMetadataListOptions(root.command('list')).action(runList)
    root.command('get <id>').action(async function action(id: string, _options, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client[resource].get(id)).data)
    })
    root
      .command('create')
      .requiredOption('--data <json|@file|->', `${singular} create JSON`)
      .option('--idempotency-key <key>', 'stable retry key')
      .action(async function action(options, command: Command) {
        const client = await loadClient(command)
        outputData(
          command,
          (
            await client[resource].create((await readJsonObject(options.data, input)) as never, {
              idempotencyKey: options.idempotencyKey,
            })
          ).data,
        )
      })
    root
      .command('update <id>')
      .requiredOption('--data <json|@file|->', `${singular} patch JSON`)
      .action(async function action(id: string, options, command: Command) {
        const client = await loadClient(command)
        outputData(
          command,
          (await client[resource].update(id, (await readJsonObject(options.data, input)) as never))
            .data,
        )
      })
    archiveOptions(root.command('archive <id>')).action(async function action(
      id: string,
      _options,
      command: Command,
    ) {
      await confirmDestructive(command, 'Archive', singular, id)
      const client = await loadClient(command)
      await client[resource].archive(id)
      outputData(command, { archived: true, id, type: singular })
    })
    root.command('restore <id>').action(async function action(
      id: string,
      _options,
      command: Command,
    ) {
      const client = await loadClient(command)
      outputData(command, (await client[resource].restore(id)).data)
    })
  }

  registerMetadataCommands('lists', 'list')
  registerMetadataCommands('services', 'service')
  registerMetadataCommands('tags', 'tag')

  const customFieldDefinitions = program
    .command('custom-field-definitions')
    .description('read and manage custom-field definitions')
  addListOptions(customFieldDefinitions.command('list'))
    .option('--archived <boolean>', 'return archived definitions', booleanValue)
    .option('--default-enabled <boolean>', 'filter default-enabled definitions', booleanValue)
    .addOption(
      new Option('--field-type <type>', 'filter canonical field type').choices([
        'contact',
        'date',
        'dropdown',
        'number',
        'project',
        'switcher',
        'tag',
        'text',
        'textarea',
        'user',
      ]),
    )
    .addOption(
      new Option('--target-type <type>', 'filter target resource').choices([
        'contact',
        'project',
        'projectJournalEntry',
        'task',
      ]),
    )
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.customFieldDefinitions as never)
    })
  customFieldDefinitions.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.customFieldDefinitions.get(id)).data)
  })
  customFieldDefinitions
    .command('create')
    .requiredOption('--data <json|@file|->', 'custom-field definition create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.customFieldDefinitions.create(
            (await readJsonObject(options.data, input)) as never,
            { idempotencyKey: options.idempotencyKey },
          )
        ).data,
      )
    })
  customFieldDefinitions
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'custom-field definition patch JSON')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.customFieldDefinitions.update(
            id,
            (await readJsonObject(options.data, input)) as never,
          )
        ).data,
      )
    })
  archiveOptions(customFieldDefinitions.command('archive <id>')).action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Archive', 'custom-field definition', id)
    const client = await loadClient(command)
    await client.customFieldDefinitions.archive(id)
    outputData(command, { archived: true, id, type: 'customFieldDefinition' })
  })
  customFieldDefinitions.command('restore <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.customFieldDefinitions.restore(id)).data)
  })

  const customFieldValues = program
    .command('custom-field-values')
    .description('read and compare-and-set custom-field values')
  customFieldValues
    .command('get <target-type> <resource-id> <field-id>')
    .action(async function action(
      targetType: 'contact' | 'project' | 'project-journal-entry' | 'task',
      resourceId: string,
      fieldId: string,
      _options,
      command: Command,
    ) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.customFieldValues.get(targetType, resourceId, fieldId)).data,
      )
    })
  customFieldValues
    .command('set <target-type> <resource-id> <field-id>')
    .requiredOption('--data <json|@file|->', 'custom-field value JSON, for example {"value":"A"}')
    .requiredOption(
      '--if-match <revision|etag>',
      'latest custom-field value revision or strong ETag',
    )
    .action(async function action(
      targetType: 'contact' | 'project' | 'project-journal-entry' | 'task',
      resourceId: string,
      fieldId: string,
      options,
      command: Command,
    ) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.customFieldValues.set(
            targetType,
            resourceId,
            fieldId,
            (await readJsonObject(options.data, input)) as never,
            { ifMatch: options.ifMatch },
          )
        ).data,
      )
    })
  archiveOptions(
    customFieldValues
      .command('clear <target-type> <resource-id> <field-id>')
      .requiredOption(
        '--if-match <revision|etag>',
        'latest custom-field value revision or strong ETag',
      ),
  ).action(async function action(
    targetType: 'contact' | 'project' | 'project-journal-entry' | 'task',
    resourceId: string,
    fieldId: string,
    options,
    command: Command,
  ) {
    await confirmDestructive(
      command,
      'Clear',
      'custom-field value',
      `${targetType}/${resourceId}/${fieldId}`,
    )
    const client = await loadClient(command)
    outputData(
      command,
      (
        await client.customFieldValues.clear(targetType, resourceId, fieldId, {
          ifMatch: options.ifMatch,
        })
      ).data,
    )
  })

  const projectTemplates = program
    .command('project-templates')
    .description('read and manage reusable project templates')
  addListOptions(projectTemplates.command('list'))
    .option('--archived <boolean>', 'return archived templates', booleanValue)
    .option('--created-at-from <date>', 'filter by earliest creation timestamp')
    .option('--created-at-to <date>', 'filter by latest creation timestamp')
    .option('--origin-project-id <id>', 'filter by source project')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.projectTemplates as never)
    })
  projectTemplates.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.projectTemplates.get(id)).data)
  })
  projectTemplates
    .command('create')
    .requiredOption('--data <json|@file|->', 'project-template create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.projectTemplates.create(
            (await readJsonObject(options.data, input)) as never,
            { idempotencyKey: options.idempotencyKey },
          )
        ).data,
      )
    })
  projectTemplates
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'project-template patch JSON')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.projectTemplates.update(
            id,
            (await readJsonObject(options.data, input)) as never,
          )
        ).data,
      )
    })
  archiveOptions(projectTemplates.command('archive <id>')).action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Archive', 'project template', id)
    const client = await loadClient(command)
    await client.projectTemplates.archive(id)
    outputData(command, { archived: true, id, type: 'projectTemplate' })
  })
  projectTemplates.command('restore <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.projectTemplates.restore(id)).data)
  })
  lifecycleOptions(projectTemplates.command('instantiate <id>'))
    .requiredOption('--data <json|@file|->', 'project-template instantiation JSON')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      const accepted = await client.projectTemplates.instantiate(
        id,
        (await readJsonObject(options.data, input)) as never,
        { idempotencyKey: options.idempotencyKey },
      )
      const result = options.wait
        ? await client.projectTemplateInstantiations.wait(accepted.data.id, {
            maxWaitMs: options.maxWait,
            pollIntervalMs: options.pollInterval,
          })
        : accepted
      outputData(command, result.data)
    })

  const projectTemplateInstantiations = program
    .command('project-template-instantiations')
    .description('inspect credential-owned project-template instantiations')
  projectTemplateInstantiations.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.projectTemplateInstantiations.get(id)).data)
  })

  const plannedWork = program
    .command('planned-work')
    .description('read and atomically replace task planned work')
  addListOptions(plannedWork.command('list'))
    .requiredOption('--start <date>', 'inclusive planned-work window start')
    .requiredOption('--end <date>', 'inclusive planned-work window end')
    .option('--project-id <id>', 'filter by project')
    .option('--task-id <id>', 'filter by task')
    .option('--user-id <id>', 'filter by user')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.plannedWork as never)
    })
  plannedWork.command('get <task-id>').action(async function action(
    taskId: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.plannedWork.getForTask(taskId)).data)
  })
  archiveOptions(lifecycleOptions(plannedWork.command('replace <task-id>')))
    .requiredOption('--data <json|@file|->', 'complete planned-work replacement JSON')
    .requiredOption('--if-match <revision|etag>', 'latest planned-work revision or strong ETag')
    .action(async function action(taskId: string, options, command: Command) {
      await confirmDestructive(command, 'Replace', 'planned work for task', taskId)
      const client = await loadClient(command)
      const accepted = await client.plannedWork.replaceForTask(
        taskId,
        (await readJsonObject(options.data, input)) as never,
        { idempotencyKey: options.idempotencyKey, ifMatch: options.ifMatch },
      )
      const result = options.wait
        ? await client.plannedWorkOperations.wait(accepted.data.id, {
            maxWaitMs: options.maxWait,
            pollIntervalMs: options.pollInterval,
          })
        : accepted
      outputData(command, result.data)
    })

  const plannedWorkOperations = program
    .command('planned-work-operations')
    .description('inspect credential-owned planned-work replacements')
  plannedWorkOperations.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.plannedWorkOperations.get(id)).data)
  })

  const changes = program
    .command('changes')
    .description('create checkpoints and read the cell-local change feed')
  addChangeFilterOptions(
    changes.command('checkpoint').description('create an empty checkpoint at the latest sequence'),
  ).action(async function action(options: ChangeCommandOptions, command: Command) {
    const client = await loadClient(command)
    const page = await client.changes.checkpoint(changeFilters(options) as never)
    outputData(command, {
      caughtUp: page.meta.page.caughtUp,
      cursor: page.meta.page.nextCursor,
      requestId: page.meta.requestId,
    })
  })
  addChangeFilterOptions(
    addListOptions(changes.command('list').description('read one change page')),
  ).action(async function action(options: ChangeCommandOptions, command: Command) {
    const client = await loadClient(command)
    const { all, cursor, maxPages } = options
    const filters = changeFilters(options)
    if (!all) {
      await outputChangePage(
        command,
        await client.changes.list({ ...filters, ...(cursor ? { cursor } : {}) } as never),
      )
      return
    }

    const mode = globalOptions(command).output
    const data: unknown[] = []
    let lastPage:
      | {
          data: unknown[]
          meta: { page: { caughtUp: boolean; nextCursor: string }; requestId: string }
        }
      | undefined
    for await (const page of client.changes.pages(
      { ...filters, ...(cursor ? { cursor } : {}) } as never,
      { maxPages },
    )) {
      lastPage = page
      if (mode === 'jsonl') await outputChangePage(command, page)
      else data.push(...page.data)
    }
    if (!lastPage || mode === 'jsonl') return
    await outputChangePage(command, { data, meta: lastPage.meta })
  })

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

  const webhookDeliveries = program
    .command('webhook-deliveries')
    .description('inspect credential-owned webhook delivery history')
  addListOptions(webhookDeliveries.command('list'))
    .option('--webhook-id <id>', 'filter by an owned webhook')
    .option('--event <event>', 'filter by event name')
    .addOption(
      new Option('--state <state>', 'filter delivery state').choices([
        'delivering',
        'failed',
        'retrying',
        'skipped',
        'succeeded',
      ]),
    )
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.webhookDeliveries as never)
    })
  webhookDeliveries.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.webhookDeliveries.get(id)).data)
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
