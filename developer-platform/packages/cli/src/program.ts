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
  type WebhookCreate,
  type WorkspaceSettingsUpdate,
} from '@teamgrid/api-client'
import { Command, Option } from 'commander'
import { type CliConfig, ConfigStore, normalizeProfileName } from './config.js'
import { type CredentialStore, SystemCredentialStore } from './credentialStore.js'
import {
  type CliExportDownload,
  maximumCliExportBytes,
  writeExportDownload,
} from './exportDownload.js'
import { readJsonObject, readStdin } from './input.js'
import { type OutputMode, sanitizeTerminalText, writeJsonLines, writeOutput } from './output.js'
import { revealWebhookSecret } from './webhookSecretOutput.js'

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
  output?: Writable & { isTTY?: boolean }
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

function isWorkspaceCurrency(
  value: unknown,
): value is NonNullable<WorkspaceSettingsUpdate['currency']> {
  return (
    typeof value === 'string' &&
    ['AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'NZD', 'USD', 'ZAR'].includes(value)
  )
}

function isWorkspaceLanguage(
  value: unknown,
): value is NonNullable<WorkspaceSettingsUpdate['defaultLanguage']> {
  return typeof value === 'string' && ['de', 'de-XX', 'en'].includes(value)
}

function isWorkspaceName(value: unknown) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 200 &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    })
  )
}

function workspaceSettingsUpdate(value: Record<string, unknown>): WorkspaceSettingsUpdate {
  const allowed = new Set([
    'currency',
    'defaultLanguage',
    'defaultPlannedTime',
    'defaultProductivity',
    'defaultShowInScheduling',
    'name',
  ])
  const keys = Object.keys(value)
  if (
    keys.length === 0 ||
    keys.some((key) => !allowed.has(key)) ||
    (value.currency !== undefined && !isWorkspaceCurrency(value.currency)) ||
    (value.defaultLanguage !== undefined && !isWorkspaceLanguage(value.defaultLanguage)) ||
    (value.defaultPlannedTime !== undefined &&
      (typeof value.defaultPlannedTime !== 'number' ||
        !Number.isFinite(value.defaultPlannedTime) ||
        value.defaultPlannedTime < 0 ||
        value.defaultPlannedTime > 525_600)) ||
    (value.defaultProductivity !== undefined &&
      (typeof value.defaultProductivity !== 'number' ||
        !Number.isFinite(value.defaultProductivity) ||
        value.defaultProductivity <= 0 ||
        value.defaultProductivity > 200)) ||
    (value.defaultShowInScheduling !== undefined &&
      typeof value.defaultShowInScheduling !== 'boolean') ||
    (value.name !== undefined && !isWorkspaceName(value.name))
  ) {
    throw new TeamGridClientError(
      'invalid_arguments',
      'Workspace settings data must contain only one or more valid public settings.',
    )
  }
  return {
    ...(isWorkspaceCurrency(value.currency) ? { currency: value.currency } : {}),
    ...(isWorkspaceLanguage(value.defaultLanguage)
      ? { defaultLanguage: value.defaultLanguage }
      : {}),
    ...(typeof value.defaultPlannedTime === 'number'
      ? { defaultPlannedTime: value.defaultPlannedTime }
      : {}),
    ...(typeof value.defaultProductivity === 'number'
      ? { defaultProductivity: value.defaultProductivity }
      : {}),
    ...(typeof value.defaultShowInScheduling === 'boolean'
      ? { defaultShowInScheduling: value.defaultShowInScheduling }
      : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
  }
}

function webhookCreate(value: Record<string, unknown>): WebhookCreate {
  const keys = Object.keys(value)
  const actions = value.actions
  let url: URL | undefined
  try {
    url = typeof value.url === 'string' ? new URL(value.url) : undefined
  } catch {
    url = undefined
  }
  if (
    keys.length !== 2 ||
    !keys.includes('actions') ||
    !keys.includes('url') ||
    !Array.isArray(actions) ||
    actions.length < 1 ||
    actions.length > 100 ||
    actions.some(
      (action) => typeof action !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(action),
    ) ||
    new Set(actions).size !== actions.length ||
    typeof value.url !== 'string' ||
    value.url.length > 2048 ||
    !url ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new TeamGridClientError(
      'invalid_arguments',
      'Webhook data requires a bounded action set and a safe HTTPS URL.',
    )
  }
  return { actions, url: value.url }
}

function commaSeparatedValues(
  maximum: number,
  description: string,
): (value: string, previous: string[]) => string[] {
  return (value, previous = []) => {
    const values = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const combined = Array.from(new Set([...previous, ...values]))
    if (
      values.length === 0 ||
      combined.length > maximum ||
      combined.some(
        (item) =>
          item.length > 128 ||
          Array.from(item).some((character) => {
            const code = character.charCodeAt(0)
            return code <= 31 || code === 127
          }),
      )
    ) {
      throw new TeamGridClientError(
        'invalid_arguments',
        `${description} must contain 1 to ${maximum} bounded identifiers.`,
      )
    }
    return combined
  }
}

function addListOptions(command: Command, maximum = 200) {
  return command
    .option('--all', 'read every page')
    .option('--cursor <cursor>', 'resume from an opaque cursor')
    .option(
      '--limit <number>',
      `resources per page (1–${maximum})`,
      integerInRange(1, maximum, 'Limit'),
    )
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
  return command.option('-y, --yes', 'skip the destructive-operation confirmation')
}

function lifecycleOptions(command: Command) {
  return command
    .option('--idempotency-key <key>', 'stable retry key')
    .option('--wait', 'wait until the asynchronous operation finishes')
    .option('--poll-interval <milliseconds>', 'poll interval while waiting', positiveInteger, 1000)
    .option('--max-wait <milliseconds>', 'maximum wait time', positiveInteger, 300_000)
}

function overrideCommandExits(command: Command) {
  command.exitOverride()
  for (const child of command.commands) overrideCommandExits(child)
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

  async function listNestedResources(
    command: Command,
    id: string,
    options: ListCommandOptions & Record<string, unknown>,
    clientMethods: {
      list(id: string, value: Record<string, unknown>): Promise<{ data: unknown[]; meta: unknown }>
      pages(
        id: string,
        value: Record<string, unknown>,
        pagination: { maxPages?: number },
      ): AsyncIterable<{ data: unknown[] }>
    },
  ) {
    const { all, maxPages, ...filters } = options
    if (!all) {
      const page = await clientMethods.list(id, filters)
      outputData(command, globalOptions(command).output === 'table' ? page.data : page)
      return
    }
    if (globalOptions(command).output === 'jsonl') {
      for await (const page of clientMethods.pages(id, filters, { maxPages })) {
        await writeJsonLines(output, page.data)
      }
      return
    }
    const resources: unknown[] = []
    for await (const page of clientMethods.pages(id, filters, { maxPages })) {
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

  const workspace = program.command('workspace').description('inspect the authenticated workspace')
  workspace.action(async function action(_options: unknown, command: Command) {
    const client = await loadClient(command)
    outputData(command, (await client.workspace.get()).data)
  })
  workspace.command('entitlements').action(async function action(
    _options: unknown,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.workspace.getEntitlements()).data)
  })

  const system = program.command('system').description('inspect API and product capabilities')
  system.command('capabilities').action(async function action(_options: unknown, command: Command) {
    const client = await loadClient(command)
    outputData(command, (await client.system.getCapabilities()).data)
  })

  const workspaceSettings = program
    .command('workspace-settings')
    .description('read and update public workspace settings')
  workspaceSettings.command('get').action(async function action(
    _options: unknown,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.workspaceSettings.get()).data)
  })
  workspaceSettings
    .command('update')
    .requiredOption('--data <json|@file|->', 'workspace settings patch JSON')
    .requiredOption(
      '--if-match <revision|etag>',
      'latest workspace settings revision or strong ETag',
    )
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      const data = workspaceSettingsUpdate(await readJsonObject(options.data, input))
      outputData(
        command,
        (
          await client.workspaceSettings.update(data, {
            idempotencyKey: options.idempotencyKey,
            ifMatch: options.ifMatch,
          })
        ).data,
      )
    })

  const events = program.command('events').description('inspect scoped public events')
  events.command('catalog').action(async function action(_options: unknown, command: Command) {
    const client = await loadClient(command)
    outputData(command, (await client.events.getCatalog()).data)
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
          acceptedOperation: started.data,
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
            acceptedOperation: accepted.data,
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

  function calendarListOptions(command: Command) {
    return addListOptions(command, 100)
      .requiredOption('--start <date-time>', 'inclusive interval start')
      .requiredOption('--end <date-time>', 'exclusive interval end')
      .option('--archived <boolean>', 'return archived calendar entries', booleanValue)
      .option(
        '--user-id <id,...>',
        'filter up to 50 user IDs (repeat or comma-separate)',
        commaSeparatedValues(50, 'User IDs'),
      )
  }

  function registerCalendarCommands(resource: 'absences' | 'appointments', singular: string) {
    const root = program.command(resource).description(`read and manage ${resource}`)
    calendarListOptions(root.command('list')).action(async function action(
      options,
      command: Command,
    ) {
      const client = await loadClient(command)
      await listResources(command, options, client[resource] as never)
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
    root.command('get <id>').action(async function action(id: string, _options, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client[resource].get(id)).data)
    })
    root
      .command('update <id>')
      .requiredOption('--data <json|@file|->', `${singular} update JSON`)
      .requiredOption('--if-match <etag>', `latest strong ${singular} ETag`)
      .action(async function action(id: string, options, command: Command) {
        const client = await loadClient(command)
        outputData(
          command,
          (
            await client[resource].update(
              id,
              (await readJsonObject(options.data, input)) as never,
              { ifMatch: options.ifMatch as never },
            )
          ).data,
        )
      })
    archiveOptions(
      root
        .command('archive <id>')
        .requiredOption('--if-match <etag>', `latest strong ${singular} ETag`),
    ).action(async function action(id: string, _options, command: Command) {
      await confirmDestructive(command, 'Archive', singular, id)
      const client = await loadClient(command)
      const options = command.opts() as { ifMatch: string }
      outputData(
        command,
        (await client[resource].archive(id, { ifMatch: options.ifMatch as never })).data,
      )
    })
    root
      .command('restore <id>')
      .requiredOption('--if-match <etag>', `latest strong ${singular} ETag`)
      .action(async function action(id: string, options, command: Command) {
        const client = await loadClient(command)
        outputData(
          command,
          (await client[resource].restore(id, { ifMatch: options.ifMatch as never })).data,
        )
      })
  }

  registerCalendarCommands('appointments', 'appointment')
  registerCalendarCommands('absences', 'absence')

  const availability = program.command('availability').description('inspect derived availability')
  availability
    .command('list')
    .requiredOption('--start <date-time>', 'inclusive availability interval start')
    .requiredOption('--end <date-time>', 'exclusive availability interval end')
    .requiredOption('--time-zone <iana-zone>', 'IANA time zone for returned intervals')
    .option(
      '--user-id <id,...>',
      'select up to 50 user IDs (repeat or comma-separate)',
      commaSeparatedValues(50, 'User IDs'),
    )
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client.availability.list(options)).data)
    })

  const activity = program.command('activity').description('inspect target-owned activity')
  addListOptions(activity.command('list'), 100)
    .addOption(
      new Option('--target-type <type>', 'target resource type')
        .choices(['contact', 'project', 'task'])
        .makeOptionMandatory(),
    )
    .requiredOption('--target-id <id>', 'target resource ID')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.activity as never)
    })

  const comments = program.command('comments').description('read and manage target comments')
  addListOptions(comments.command('list'), 100)
    .option('--archived <boolean>', 'return archived comments', booleanValue)
    .addOption(
      new Option('--target-type <type>', 'target resource type')
        .choices(['contact', 'project', 'task'])
        .makeOptionMandatory(),
    )
    .requiredOption('--target-id <id>', 'target resource ID')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.comments as never)
    })
  comments
    .command('create')
    .requiredOption('--data <json|@file|->', 'comment create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.comments.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  comments.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.comments.get(id)).data)
  })
  archiveOptions(
    comments
      .command('archive <id>')
      .requiredOption('--if-match <etag>', 'latest strong comment ETag'),
  ).action(async function action(id: string, _options, command: Command) {
    await confirmDestructive(command, 'Archive', 'comment', id)
    const client = await loadClient(command)
    const options = command.opts() as { ifMatch: string }
    outputData(
      command,
      (await client.comments.archive(id, { ifMatch: options.ifMatch as never })).data,
    )
  })
  comments
    .command('restore <id>')
    .requiredOption('--if-match <etag>', 'latest strong comment ETag')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.comments.restore(id, { ifMatch: options.ifMatch as never })).data,
      )
    })

  const documents = program.command('documents').description('read and manage documents')
  addListOptions(documents.command('list'), 100)
    .option('--archived <boolean>', 'return archived documents', booleanValue)
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.documents as never)
    })
  documents
    .command('create')
    .requiredOption('--data <json|@file|->', 'document create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.documents.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  documents.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.documents.get(id)).data)
  })
  documents
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'document update JSON')
    .requiredOption('--if-match <etag>', 'latest strong document ETag')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.documents.update(id, (await readJsonObject(options.data, input)) as never, {
            ifMatch: options.ifMatch as never,
          })
        ).data,
      )
    })
  archiveOptions(
    documents
      .command('archive <id>')
      .requiredOption('--if-match <etag>', 'latest strong document ETag'),
  ).action(async function action(id: string, _options, command: Command) {
    await confirmDestructive(command, 'Archive', 'document', id)
    const client = await loadClient(command)
    const options = command.opts() as { ifMatch: string }
    outputData(
      command,
      (await client.documents.archive(id, { ifMatch: options.ifMatch as never })).data,
    )
  })
  documents
    .command('restore <id>')
    .requiredOption('--if-match <etag>', 'latest strong document ETag')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.documents.restore(id, { ifMatch: options.ifMatch as never })).data,
      )
    })

  const files = program.command('files').description('read and manage file metadata')
  addListOptions(files.command('list'), 100)
    .option('--archived <boolean>', 'return archived files', booleanValue)
    .addOption(
      new Option('--entity-type <type>', 'filter by owning entity type').choices([
        'comment',
        'contact',
        'customField',
        'outcome',
        'project',
        'streamItem',
        'task',
        'team',
      ]),
    )
    .option('--entity-id <id>', 'filter by owning entity ID')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.files as never)
    })
  files
    .command('get <id>')
    .option('--archived <boolean>', 'allow an archived file', booleanValue)
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client.files.get(id, options)).data)
    })
  files
    .command('rename <id>')
    .requiredOption('--data <json|@file|->', 'file rename JSON')
    .requiredOption('--if-match <etag>', 'latest strong file ETag')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.files.rename(id, (await readJsonObject(options.data, input)) as never, {
            ifMatch: options.ifMatch as never,
          })
        ).data,
      )
    })
  archiveOptions(
    files.command('archive <id>').requiredOption('--if-match <etag>', 'latest strong file ETag'),
  ).action(async function action(id: string, _options, command: Command) {
    await confirmDestructive(command, 'Archive', 'file', id)
    const client = await loadClient(command)
    const options = command.opts() as { ifMatch: string }
    outputData(
      command,
      (await client.files.archive(id, { ifMatch: options.ifMatch as never })).data,
    )
  })
  files
    .command('restore <id>')
    .requiredOption('--if-match <etag>', 'latest strong file ETag')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.files.restore(id, { ifMatch: options.ifMatch as never })).data,
      )
    })
  files.command('download-intent <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.files.createDownloadIntent(id)).data)
  })

  const fileUploadIntents = program
    .command('file-upload-intents')
    .description('create and complete direct file uploads')
  fileUploadIntents
    .command('create')
    .requiredOption('--data <json|@file|->', 'file upload intent JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.fileUploadIntents.create(
            (await readJsonObject(options.data, input)) as never,
            { idempotencyKey: options.idempotencyKey },
          )
        ).data,
      )
    })
  fileUploadIntents.command('finalize <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.fileUploadIntents.finalize(id)).data)
  })
  archiveOptions(fileUploadIntents.command('cancel <id>')).action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    await confirmDestructive(command, 'Cancel', 'file upload intent', id)
    const client = await loadClient(command)
    outputData(command, (await client.fileUploadIntents.cancel(id)).data)
  })

  const members = program.command('members').description('read and administer workspace members')
  addListOptions(members.command('list'), 100)
    .option('--include-pii', 'include explicitly scoped member profile fields')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.members as never)
    })
  members
    .command('get <id>')
    .option('--include-pii', 'include explicitly scoped member profile fields')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client.members.get(id, options)).data)
    })
  members
    .command('update-role <id>')
    .requiredOption('--data <json|@file|->', 'member role update JSON')
    .requiredOption('--if-match <revision|etag>', 'latest member revision or strong ETag')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.members.updateRole(
            id,
            (await readJsonObject(options.data, input)) as never,
            {
              ifMatch: options.ifMatch as never,
            },
          )
        ).data,
      )
    })
  archiveOptions(
    members
      .command('remove <id>')
      .requiredOption('--if-match <revision|etag>', 'latest member revision or strong ETag'),
  ).action(async function action(id: string, _options, command: Command) {
    await confirmDestructive(command, 'Remove', 'workspace member', id)
    const client = await loadClient(command)
    const options = command.opts() as { ifMatch: string }
    await client.members.remove(id, { ifMatch: options.ifMatch as never })
    outputData(command, { id, removed: true, type: 'member' })
  })

  const invitations = program
    .command('invitations')
    .description('read and administer workspace invitations')
  addListOptions(invitations.command('list'), 100)
    .option('--include-pii', 'include the invited email when explicitly scoped')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.invitations as never)
    })
  invitations
    .command('get <id>')
    .option('--include-pii', 'include the invited email when explicitly scoped')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client.invitations.get(id, options)).data)
    })
  invitations
    .command('create')
    .requiredOption('--data <json|@file|->', 'invitation create JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.invitations.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  invitations
    .command('resend <id>')
    .requiredOption('--if-match <revision|etag>', 'latest invitation revision or strong ETag')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      await client.invitations.resend(id, {
        idempotencyKey: options.idempotencyKey,
        ifMatch: options.ifMatch as never,
      })
      outputData(command, { id, resent: true, type: 'invitation' })
    })
  archiveOptions(
    invitations
      .command('cancel <id>')
      .requiredOption('--if-match <revision|etag>', 'latest invitation revision or strong ETag'),
  ).action(async function action(id: string, _options, command: Command) {
    await confirmDestructive(command, 'Cancel', 'workspace invitation', id)
    const client = await loadClient(command)
    const options = command.opts() as { ifMatch: string }
    await client.invitations.cancel(id, { ifMatch: options.ifMatch as never })
    outputData(command, { cancelled: true, id, type: 'invitation' })
  })

  function registerAdministrationCollection(
    resourceName: 'groups' | 'roles',
    singular: 'group' | 'role',
  ) {
    const root = program
      .command(resourceName)
      .description(`read and administer workspace ${resourceName}`)
    addListOptions(root.command('list'), 100).action(async function action(
      options,
      command: Command,
    ) {
      const client = await loadClient(command)
      await listResources(command, options, client[resourceName] as never)
    })
    root.command('get <id>').action(async function action(id: string, _options, command: Command) {
      const client = await loadClient(command)
      outputData(command, (await client[resourceName].get(id)).data)
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
            await client[resourceName].create(
              (await readJsonObject(options.data, input)) as never,
              {
                idempotencyKey: options.idempotencyKey,
              },
            )
          ).data,
        )
      })
    root
      .command('update <id>')
      .requiredOption('--data <json|@file|->', `${singular} update JSON`)
      .requiredOption('--if-match <revision|etag>', `latest ${singular} revision or strong ETag`)
      .action(async function action(id: string, options, command: Command) {
        const client = await loadClient(command)
        outputData(
          command,
          (
            await client[resourceName].update(
              id,
              (await readJsonObject(options.data, input)) as never,
              {
                ifMatch: options.ifMatch as never,
              },
            )
          ).data,
        )
      })
    archiveOptions(
      root
        .command('remove <id>')
        .requiredOption('--if-match <revision|etag>', `latest ${singular} revision or strong ETag`),
    ).action(async function action(id: string, _options, command: Command) {
      await confirmDestructive(command, 'Remove', `workspace ${singular}`, id)
      const client = await loadClient(command)
      const options = command.opts() as { ifMatch: string }
      await client[resourceName].remove(id, { ifMatch: options.ifMatch as never })
      outputData(command, { id, removed: true, type: singular })
    })
  }

  registerAdministrationCollection('roles', 'role')
  registerAdministrationCollection('groups', 'group')

  const search = program.command('search').description('search permitted TeamGrid resources')
  search
    .command('query')
    .requiredOption('--data <json|@file|->', 'search request JSON')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.search.query((await readJsonObject(options.data, input)) as never)).data,
      )
    })

  const exportsCommand = program
    .command('exports')
    .description('create and download bounded exports')
  exportsCommand
    .command('create')
    .requiredOption('--data <json|@file|->', 'export specification JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.exports.create((await readJsonObject(options.data, input)) as never, {
            idempotencyKey: options.idempotencyKey,
          })
        ).data,
      )
    })
  exportsCommand.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.exports.get(id)).data)
  })
  exportsCommand.command('download-intent <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.exports.createDownloadIntent(id)).data)
  })
  exportsCommand
    .command('download <id>')
    .option('--file <path>', 'create a new output file without overwriting')
    .option('--stdout', 'write raw export bytes to standard output')
    .option('--intent-token-stdin', 'read a short-lived download intent token from stdin')
    .option(
      '--max-bytes <number>',
      `download safety limit (1–${maximumCliExportBytes})`,
      integerInRange(1, maximumCliExportBytes, 'Maximum export bytes'),
      maximumCliExportBytes,
    )
    .action(async function action(id: string, options, command: Command) {
      if (Boolean(options.file) === Boolean(options.stdout)) {
        throw new TeamGridClientError(
          'invalid_arguments',
          'Choose exactly one export destination: --file or --stdout.',
        )
      }
      const client = await loadClient(command)
      let intentToken: string
      if (options.intentTokenStdin) {
        intentToken = (await readStdin(input)).trim()
        if (!/^ex1\.\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(intentToken)) {
          throw new TeamGridClientError(
            'invalid_arguments',
            'Standard input did not contain a valid export download intent token.',
          )
        }
      } else {
        const intent = (await client.exports.createDownloadIntent(id)).data as {
          attributes?: { token?: unknown }
        }
        if (typeof intent.attributes?.token !== 'string') {
          throw new TeamGridClientError(
            'invalid_api_response',
            'The export download intent response did not contain a token.',
          )
        }
        intentToken = intent.attributes.token
      }
      const download = (await client.exports.download(id, {
        intentToken,
        maxBytes: options.maxBytes,
      })) as unknown as CliExportDownload
      const written = await writeExportDownload({
        download,
        file: options.file,
        maximumBytes: options.maxBytes,
        output: output as Writable & { isTTY?: boolean },
        stdout: options.stdout,
      })
      if (!options.stdout) outputData(command, written)
    })

  const automationActions = program
    .command('automation-actions')
    .description('inspect the public automation action catalog')
  automationActions.command('list').action(async function action(_options, command: Command) {
    const client = await loadClient(command)
    outputData(command, (await client.automationActions.list()).data)
  })

  const automationDefinitions = program
    .command('automation-definitions')
    .description('read and administer automation definitions')
  addListOptions(automationDefinitions.command('list'), 100)
    .option('--archived <boolean>', 'return archived definitions', booleanValue)
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.automationDefinitions as never)
    })
  automationDefinitions.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.automationDefinitions.get(id)).data)
  })
  automationDefinitions
    .command('create')
    .requiredOption('--data <json|@file|->', 'automation definition JSON')
    .option('--idempotency-key <key>', 'stable retry key')
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.automationDefinitions.create(
            (await readJsonObject(options.data, input)) as never,
            {
              idempotencyKey: options.idempotencyKey,
            },
          )
        ).data,
      )
    })
  automationDefinitions
    .command('update <id>')
    .requiredOption('--data <json|@file|->', 'automation definition update JSON')
    .requiredOption('--if-match <revision|etag>', 'latest automation revision or strong ETag')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (
          await client.automationDefinitions.update(
            id,
            (await readJsonObject(options.data, input)) as never,
            { ifMatch: options.ifMatch as never },
          )
        ).data,
      )
    })
  archiveOptions(
    automationDefinitions
      .command('archive <id>')
      .requiredOption('--if-match <revision|etag>', 'latest automation revision or strong ETag'),
  ).action(async function action(id: string, _options, command: Command) {
    await confirmDestructive(command, 'Archive', 'automation definition', id)
    const client = await loadClient(command)
    const options = command.opts() as { ifMatch: string }
    outputData(
      command,
      (await client.automationDefinitions.archive(id, { ifMatch: options.ifMatch as never })).data,
    )
  })
  automationDefinitions
    .command('restore <id>')
    .requiredOption('--if-match <revision|etag>', 'latest automation revision or strong ETag')
    .action(async function action(id: string, options, command: Command) {
      const client = await loadClient(command)
      outputData(
        command,
        (await client.automationDefinitions.restore(id, { ifMatch: options.ifMatch as never }))
          .data,
      )
    })

  const automationDefinitionVersions = program
    .command('automation-definition-versions')
    .description('inspect immutable automation definition versions')
  addListOptions(automationDefinitionVersions.command('list <definition-id>'), 100).action(
    async function action(definitionId: string, options, command: Command) {
      const client = await loadClient(command)
      await listNestedResources(
        command,
        definitionId,
        options,
        client.automationDefinitionVersions as never,
      )
    },
  )

  const automationRuns = program
    .command('automation-runs')
    .description('inspect and control automation runs')
  addListOptions(automationRuns.command('list'), 100)
    .option('--definition-id <id>', 'filter by automation definition')
    .option('--reference-id <id>', 'filter by target resource')
    .addOption(
      new Option('--reference-type <type>', 'filter target resource type').choices([
        'contact',
        'project',
        'task',
        'user',
        'workspace',
      ]),
    )
    .addOption(
      new Option('--state <state>', 'filter run state').choices([
        'aborted',
        'failed',
        'running',
        'succeeded',
      ]),
    )
    .action(async function action(options, command: Command) {
      const client = await loadClient(command)
      await listResources(command, options, client.automationRuns as never)
    })
  automationRuns.command('get <id>').action(async function action(
    id: string,
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.automationRuns.get(id)).data)
  })
  archiveOptions(
    automationRuns
      .command('abort <id>')
      .requiredOption(
        '--if-match <revision|etag>',
        'latest automation run revision or strong ETag',
      ),
  ).action(async function action(id: string, _options, command: Command) {
    await confirmDestructive(command, 'Abort', 'automation run', id)
    const client = await loadClient(command)
    const options = command.opts() as { ifMatch: string }
    outputData(
      command,
      (await client.automationRuns.abort(id, { ifMatch: options.ifMatch as never })).data,
    )
  })

  const integrationInstallations = program
    .command('integration-installations')
    .description('inspect redacted integration installation metadata')
  integrationInstallations.command('list').action(async function action(
    _options,
    command: Command,
  ) {
    const client = await loadClient(command)
    outputData(command, (await client.integrationInstallations.list()).data)
  })

  const webhooks = program.command('webhooks').description('read and manage webhooks')
  addListOptions(webhooks.command('list'), 100).action(async function action(
    options,
    command: Command,
  ) {
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
    .option('--secret-file <path>', 'create a new mode-0600 secret file without overwriting')
    .option('--secret-stdout', 'write only the raw reveal-once secret to stdout')
    .action(async function action(options, command: Command) {
      if (Boolean(options.secretFile) === Boolean(options.secretStdout)) {
        throw new TeamGridClientError(
          'invalid_arguments',
          'Choose exactly one reveal-only destination: --secret-file or --secret-stdout.',
        )
      }
      const client = await loadClient(command)
      const data = webhookCreate(await readJsonObject(options.data, input))
      const receipt = await revealWebhookSecret({
        file: options.secretFile,
        output,
        rotate: async () =>
          (
            await client.webhooks.create(data, {
              idempotencyKey: options.idempotencyKey,
            })
          ).data,
        stdout: options.secretStdout,
      })
      if (receipt) outputData(command, receipt)
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
  archiveOptions(
    webhooks
      .command('rotate-secret <id>')
      .description('rotate and reveal a v2 webhook signing secret exactly once')
      .requiredOption('--if-match <revision|etag>', 'latest webhook revision or strong ETag')
      .option('--idempotency-key <key>', 'stable retry key')
      .option('--secret-file <path>', 'create a new mode-0600 secret file without overwriting')
      .option('--secret-stdout', 'write only the raw reveal-once secret to stdout'),
  ).action(async function action(id: string, options, command: Command) {
    if (Boolean(options.secretFile) === Boolean(options.secretStdout)) {
      throw new TeamGridClientError(
        'invalid_arguments',
        'Choose exactly one reveal-only destination: --secret-file or --secret-stdout.',
      )
    }
    await confirmDestructive(command, 'Rotate the signing secret for', 'webhook', id)
    const client = await loadClient(command)
    const receipt = await revealWebhookSecret({
      file: options.secretFile,
      output,
      rotate: async () =>
        (
          await client.webhooks.rotateSecret(id, {
            idempotencyKey: options.idempotencyKey,
            ifMatch: options.ifMatch,
          })
        ).data,
      stdout: options.secretStdout,
    })
    if (receipt) outputData(command, receipt)
  })

  // Commander does not propagate exitOverride() from the root to nested commands.
  // Throwing from every command keeps usage failures catchable and gives scripts
  // the documented exit code instead of terminating the process directly.
  overrideCommandExits(program)
  return program
}

export function exitCodeForError(error: unknown) {
  if (error instanceof TeamGridApiError) {
    return (
      ({ 401: 3, 403: 4, 404: 5, 409: 6, 412: 6, 428: 2, 429: 7 } as Record<number, number>)[
        error.status
      ] || 1
    )
  }
  if (error instanceof TeamGridClientError) {
    if (error.code === 'cancelled') return 0
    return localUsageErrorCodes.has(error.code) ? 2 : 1
  }
  return 1
}
