import { createHash, randomBytes } from 'node:crypto'
import { MongoClient } from 'mongodb'
import {
  createFederatedMcpNodeServer,
  createFederatedMcpRuntime,
  createMongoOAuthBrowserStore,
  createMongoOAuthRoutingDirectory,
  createOAuthClientRegistry,
  OAuthBrokerInvalidClientError,
} from '../../packages/mcp-server/dist/index.js'
import { supportedOAuthScopes } from '../../packages/mcp-server/dist/toolScopes.js'
import { createMongoAdmission, writeConcern } from './admission.mjs'
import {
  immutableConfig,
  parseClientPolicy,
  parseServiceConfig,
  readPrivateJson,
} from './config.mjs'
import { responseJson, underSignal } from './io.mjs'

const unavailable = () => {
  throw new Error('Federated bootstrap unavailable.')
}

/** No default DB. TLS, authenticated replica set, fixed pool/budgets and no driver logging. */
export function createMongoConnection(config, { Client = MongoClient } = {}) {
  const query = new URLSearchParams(config.mongo.uri.split('?')[1] ?? '')
  const keys = [...query.keys()].map((key) => key.toLowerCase())
  if (
    config.mongo.uri.includes('#') ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key) => !['replicaset', 'tls', 'authsource', 'authmechanism', 'tlscafile'].includes(key),
    )
  )
    unavailable()
  const client = new Client(config.mongo.uri, {
    appName: 'teamgrid-federated-mcp',
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
    socketTimeoutMS: 5000,
    waitQueueTimeoutMS: 3000,
    maxPoolSize: 20,
    minPoolSize: 0,
    maxConnecting: 2,
    retryReads: false,
    retryWrites: false,
    readPreference: 'primary',
    monitorCommands: false,
    mongodbLogPath: { write: () => {} },
    mongodbLogComponentSeverities: { default: 'off' },
  })
  const options = client.options
  if (
    !options.replicaSet ||
    options.directConnection ||
    options.loadBalanced ||
    !options.tls ||
    !options.credentials?.username ||
    !options.credentials?.password
  )
    unavailable()
  return client
}

function checkPrimary(hello, replicaSet) {
  if (
    hello.isWritablePrimary !== true ||
    hello.setName !== replicaSet ||
    hello.msg === 'isdbgrid' ||
    !Number.isSafeInteger(hello.logicalSessionTimeoutMinutes) ||
    hello.logicalSessionTimeoutMinutes < 1
  )
    unavailable()
}

export async function createFederatedService({
  readConfig,
  readPolicy = readPrivateJson,
  fetcher = fetch,
  Client = MongoClient,
}) {
  const config = parseServiceConfig(readConfig())
  const fixed = immutableConfig(config)
  const state = () => {
    try {
      const current = parseServiceConfig(readConfig())
      return immutableConfig(current) === fixed ? current : null
    } catch {
      return null
    }
  }
  const policy = () => parseClientPolicy(readPolicy(config.clientPolicyFile))
  const clients = createOAuthClientRegistry({
    registeredClients: () => policy().clients,
    allowedMetadataOrigins: () => policy().cimdAllowedOrigins,
    metadataSupported: () => policy().cimdEnabled,
  })
  // Validate all static records and origin policy before any database I/O; no CIMD fetch.
  try {
    await clients.resolve('bootstrap-policy-validation', AbortSignal.timeout(5000))
  } catch (error) {
    if (!(error instanceof OAuthBrokerInvalidClientError)) throw error
  }
  const connection = createMongoConnection(config, { Client })
  let runtime,
    server,
    closed = false,
    shutdown
  const cleanup = () => {
    if (!shutdown) {
      closed = true
      shutdown = (async () => {
        try {
          if (server?.server.listening) await server.close()
          else if (runtime) await runtime.close()
        } finally {
          await connection.close()
        }
      })()
    }
    return shutdown
  }
  try {
    const startup = AbortSignal.timeout(15000)
    await underSignal(connection.connect(), startup)
    const db = connection.db(config.mongo.database)
    const commandOptions = { readPreference: 'primary', maxTimeMS: 5000 }
    const hello = await underSignal(
      db.command({ hello: 1 }, { ...commandOptions, signal: startup }),
      startup,
    )
    checkPrimary(hello, connection.options.replicaSet)
    const control = db.collection('control'),
      probes = db.collection('probes')
    const binding = {
      _id: 'deployment',
      version: 1,
      issuer: config.issuer,
      resource: config.resource,
      admissionPolicyHash: createHash('sha256')
        .update(JSON.stringify(config.admission))
        .digest('hex'),
    }
    await underSignal(
      control.updateOne(
        binding,
        { $setOnInsert: binding },
        { upsert: true, writeConcern, maxTimeMS: 5000, signal: startup },
      ),
      startup,
    )
    const directory = createMongoOAuthRoutingDirectory({
      issuer: config.issuer,
      resource: config.resource,
      cells: config.cells,
      collection: db.collection('routes'),
    })
    const browserStore = createMongoOAuthBrowserStore({
      issuer: config.issuer,
      resource: config.resource,
      cells: config.cells,
      collection: db.collection('browsers'),
    })
    const admission = createMongoAdmission({
      issuer: config.issuer,
      resource: config.resource,
      collection: db.collection('admission'),
      policy: config.admission,
    })
    await Promise.all([
      directory.initialize(startup),
      browserStore.initialize(startup),
      admission.initialize(startup),
      underSignal(
        probes.createIndex(
          { expiresAt: 1 },
          {
            name: 'federation_probe_retention',
            expireAfterSeconds: 0,
            writeConcern,
            maxTimeMS: 5000,
            signal: startup,
          },
        ),
        startup,
      ),
    ])
    const probeId = createHash('sha256').update(randomBytes(32)).digest('hex')
    let pending,
      expires = 0,
      lastReady = false
    const probe = async () => {
      if (closed || !state()?.enabled) return false
      if (expires > Date.now()) return lastReady
      if (pending) return pending
      pending = (async () => {
        const signal = AbortSignal.timeout(4000)
        try {
          await clients.resolve('bootstrap-policy-validation', signal).catch((error) => {
            if (!(error instanceof OAuthBrokerInvalidClientError)) throw error
          })
          checkPrimary(
            await underSignal(db.command({ hello: 1 }, { ...commandOptions, signal }), signal),
            connection.options.replicaSet,
          )
          const readOptions = {
            readPreference: 'primary',
            readConcern: { level: 'linearizable' },
            maxTimeMS: 5000,
            signal,
          }
          const recorded = await underSignal(
            control.findOne({ _id: binding._id }, readOptions),
            signal,
          )
          if (
            !recorded ||
            Object.keys(recorded).length !== Object.keys(binding).length ||
            Object.entries(binding).some(([key, value]) => recorded[key] !== value)
          )
            unavailable()
          const canary = { _id: probeId, expiresAt: new Date(Date.now() + 60000) }
          await underSignal(
            probes.updateOne(
              { _id: probeId },
              { $set: canary },
              { upsert: true, writeConcern, maxTimeMS: 5000, signal },
            ),
            signal,
          )
          const confirmed = await underSignal(probes.findOne({ _id: probeId }, readOptions), signal)
          if (confirmed?._id !== probeId || +confirmed.expiresAt !== +canary.expiresAt)
            unavailable()
          await Promise.all(
            config.cells.map(async (cell) => {
              const url = new URL('./metadata', cell.providerUrl)
              const response = await underSignal(
                fetcher(url, {
                  signal,
                  method: 'GET',
                  redirect: 'error',
                  credentials: 'omit',
                  headers: {
                    'X-TeamGrid-OAuth-Service-Authorization': `Bearer ${cell.serviceSecret}`,
                    Accept: 'application/json',
                  },
                }),
                signal,
              )
              const metadata = await responseJson(response, signal)
              if (
                metadata.issuer !== config.issuer ||
                metadata.authorization_endpoint !==
                  new URL('/oauth/authorize', config.issuer).href ||
                metadata.token_endpoint !== new URL('/oauth/token', config.issuer).href ||
                metadata.revocation_endpoint !== new URL('/oauth/revoke', config.issuer).href ||
                metadata.authorization_response_iss_parameter_supported !== true ||
                JSON.stringify(metadata.code_challenge_methods_supported) !== '["S256"]' ||
                !metadata.grant_types_supported?.includes('authorization_code') ||
                !metadata.grant_types_supported?.includes('refresh_token') ||
                !['none', 'client_secret_basic', 'client_secret_post'].every((method) =>
                  metadata.token_endpoint_auth_methods_supported?.includes(method),
                ) ||
                !supportedOAuthScopes.every((scope) =>
                  metadata.scopes_supported?.includes(scope),
                ) ||
                (policy().cimdEnabled && metadata.client_id_metadata_document_supported !== true)
              )
                unavailable()
            }),
          )
          return !closed && state()?.enabled === true
        } catch {
          return false
        }
      })()
      try {
        lastReady = await pending
        expires = Date.now() + 10000
        return lastReady
      } finally {
        pending = undefined
      }
    }
    runtime = createFederatedMcpRuntime({
      resourceUrl: config.resource,
      issuerUrl: config.issuer,
      cells: config.cells,
      directory,
      browserStore,
      clients,
      selectionUiOrigin: config.selectionUiOrigin,
      workspaceRootDomain: config.workspaceRootDomain,
      workspaceUiMode: config.workspaceUiMode,
      selectionServiceSecret: config.selectionServiceSecret,
      allowedOrigins: config.allowedOrigins,
      hostClients: config.hostClients,
      enabled: () => !closed && state()?.enabled === true,
      writesEnabled: () => state()?.writesEnabled === true,
      admitRequest: (request) => admission.admit(request),
      ready: probe,
      fetch: fetcher,
    })
    server = createFederatedMcpNodeServer(config.resource, runtime)
    return {
      server: server.server,
      ready: runtime.ready,
      close: cleanup,
      async listen() {
        if (closed) unavailable()
        await new Promise((resolve, reject) => {
          const error = (cause) => {
            server.server.removeListener('listening', listening)
            reject(cause)
          }
          const listening = () => {
            server.server.removeListener('error', error)
            resolve()
          }
          server.server.once('error', error)
          server.server.once('listening', listening)
          server.server.listen(config.listen.port, config.listen.host)
        })
      },
    }
  } catch {
    await underSignal(cleanup(), AbortSignal.timeout(5000)).catch(() => {})
    return unavailable()
  }
}
