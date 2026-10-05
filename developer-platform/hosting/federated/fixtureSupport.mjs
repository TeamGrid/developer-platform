import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { supportedOAuthScopes } from '../../packages/mcp-server/dist/toolScopes.js'

export function fixture() {
  return {
    version: 1,
    issuer: 'https://mcp.example.test/',
    resource: 'https://mcp.example.test/mcp',
    enabled: true,
    writesEnabled: true,
    selectionUiOrigin: 'https://login.example.test/',
    workspaceRootDomain: 'example.test',
    selectionServiceSecret: 'b'.repeat(48),
    clientPolicyFile: resolve(tmpdir(), 'synthetic-client-policy.json'),
    mongo: {
      uri: 'mongodb://fixture:fixture@db.example.test/?replicaSet=rs0&tls=true',
      database: 'teamgrid_federation_test',
    },
    admission: {
      hmacSecret: 'h'.repeat(48),
      globalPerMinute: 100,
      publicPerMinute: 50,
      credentialPerMinute: 20,
    },
    allowedOrigins: [],
    hostClients: [],
    listen: { host: '127.0.0.1', port: 8080 },
    cells: [
      {
        region: 'de',
        cellId: 'de-test',
        serviceSecret: 's'.repeat(48),
        apiOriginSecret: 'a'.repeat(48),
        providerUrl:
          'https://de.example.test/internal/developer/oauth/integrations/ai-global/access',
        apiBaseUrl: 'https://api-de.example.test/v1',
      },
    ],
  }
}
export function policy() {
  return {
    version: 1,
    cimdEnabled: false,
    cimdAllowedOrigins: [],
    clients: [
      {
        _id: 'registered-client-fixture',
        clientId: 'host1',
        name: 'Fixture host',
        redirectUris: ['https://host.example.test/callback'],
        status: 'active',
        tokenEndpointAuthMethod: 'none',
      },
    ],
  }
}
export function metadata(config) {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}oauth/authorize`,
    token_endpoint: `${config.issuer}oauth/token`,
    revocation_endpoint: `${config.issuer}oauth/revoke`,
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...supportedOAuthScopes],
  }
}
export function memoryCollection() {
  const rows = new Map(),
    calls = [],
    indexes = []
  return {
    rows,
    calls,
    indexes,
    async createIndex(key, options) {
      indexes.push({ key, ...options })
      return options.name
    },
    async findOne(filter, options) {
      calls.push(['read', filter, options])
      return structuredClone(rows.get(filter._id) ?? null)
    },
    async insertOne(value, options) {
      calls.push(['insert', value, options])
      if (rows.has(value._id)) throw new Error('Duplicate')
      rows.set(value._id, structuredClone(value))
      return { acknowledged: true }
    },
    async updateOne(filter, update, options) {
      calls.push(['write', filter, update, options])
      const old = rows.get(filter._id)
      if (
        old &&
        Object.entries(filter).some(
          ([key, value]) => JSON.stringify(old[key]) !== JSON.stringify(value),
        )
      )
        throw new Error('Duplicate immutable record')
      if (old && update.$set) {
        rows.set(filter._id, structuredClone(update.$set))
        return { modifiedCount: 1 }
      }
      if (!old) rows.set(filter._id, structuredClone(update.$setOnInsert ?? update.$set))
      return { modifiedCount: 0 }
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push(['increment', filter, update, options])
      const value = rows.get(filter._id) ?? { _id: filter._id, ...update.$setOnInsert, count: 0 }
      value.count += update.$inc.count
      rows.set(filter._id, value)
      return structuredClone(value)
    },
  }
}
