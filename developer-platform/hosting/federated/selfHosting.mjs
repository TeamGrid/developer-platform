import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { parseServiceConfig } from './config.mjs'

const unavailable = () => {
  throw new Error('Self-hosted deployment specification unavailable.')
}
export const oauthLogHeaders = [
  'X-TeamGrid-OAuth-Service-Authorization',
  'X-TeamGrid-OAuth-Browser-Service-Authorization',
  'X-TeamGrid-OAuth-Browser-Context',
  'X-TeamGrid-OAuth-Exchange-ID',
]
const variants = (name) => [
  name,
  name.replace(/[A-Za-z]+/g, (part) => part[0].toUpperCase() + part.slice(1).toLowerCase()),
  name.toLowerCase(),
]
export function caddyRuntimeRedaction() {
  const headers = [
    'Authorization',
    'Proxy-Authorization',
    'Cookie',
    'X-TeamGrid-Edge-Origin-Authorization',
    ...oauthLogHeaders,
  ].flatMap(variants)
  return `log default {\n  format filter {\n    request>uri replace [redacted]\n${[...new Set(headers)].map((name) => `    request>headers>${name} delete`).join('\n')}\n  }\n}`
}

/** Prepare declarative files only. This does not provision a DB, attach Caddy or deploy. */
export function createSelfHostedArtifacts(input, specification) {
  const config = parseServiceConfig(input)
  const keys = [
    'version',
    'project',
    'sourceRevision',
    'image',
    'runtimeDirectory',
    'databaseNetwork',
    'browserServiceIps',
  ]
  if (
    !specification ||
    Array.isArray(specification) ||
    Object.keys(specification).some((key) => !keys.includes(key)) ||
    specification.version !== 1 ||
    !/^teamgrid-federation-(staging|production)$/.test(specification.project) ||
    !/^[a-f0-9]{40}$/.test(specification.sourceRevision) ||
    !/^ghcr\.io\/teamgrid\/teamgrid-federated-mcp@sha256:[a-f0-9]{64}$/.test(specification.image) ||
    typeof specification.runtimeDirectory !== 'string' ||
    !isAbsolute(specification.runtimeDirectory) ||
    specification.runtimeDirectory.length > 4096 ||
    specification.databaseNetwork !== `${specification.project}-db` ||
    !Array.isArray(specification.browserServiceIps) ||
    specification.browserServiceIps.length < 1 ||
    specification.browserServiceIps.length > 16 ||
    new Set(specification.browserServiceIps).size !== specification.browserServiceIps.length ||
    specification.browserServiceIps.some((ip) => typeof ip !== 'string' || !isIP(ip))
  )
    unavailable()
  const host = new URL(config.issuer).host
  if (
    new URL(config.issuer).port ||
    isIP(host) ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) ||
    config.listen.host !== '0.0.0.0' ||
    config.listen.port !== 8080 ||
    config.clientPolicyFile !== '/run/teamgrid-federation/clients.json'
  )
    unavailable()
  const project = specification.project,
    ingress = `${project}-ingress`
  const node = (replica) => ({
    image: specification.image,
    user: '1000:1000',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    restart: 'unless-stopped',
    init: true,
    stop_grace_period: '15s',
    mem_limit: '512m',
    cpus: '0.75',
    pids_limit: 128,
    environment: {
      NODE_ENV: 'production',
      TEAMGRID_FEDERATION_CONFIG_FILE: '/run/teamgrid-federation/service.json',
    },
    volumes: [
      {
        type: 'bind',
        source: specification.runtimeDirectory,
        target: '/run/teamgrid-federation',
        read_only: true,
        bind: { create_host_path: false },
      },
    ],
    tmpfs: ['/tmp:size=16777216,uid=1000,gid=1000,mode=0700'],
    networks: {
      ingress: { aliases: [`${project}-${replica}`] },
      database: {},
      egress: {},
    },
    healthcheck: {
      test: [
        'CMD',
        'node',
        '-e',
        "fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      interval: '15s',
      timeout: '3s',
      retries: 3,
      start_period: '20s',
    },
    labels: { 'com.teamgrid.federation.source': specification.sourceRevision },
    logging: { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '3' } },
  })
  const compose = {
    name: project,
    services: { 'federation-a': node('a'), 'federation-b': node('b') },
    networks: {
      ingress: { external: true, name: ingress },
      database: { external: true, name: specification.databaseNetwork },
      egress: {},
    },
  }
  const proxy = `reverse_proxy ${project}-a:8080 ${project}-b:8080 {
    lb_policy round_robin
    lb_try_duration 0s
    flush_interval -1
    health_uri /readyz
    health_headers {
      Host ${host}
    }
    health_interval 10s
    health_timeout 5s
    header_up -X-TeamGrid-Edge-Origin-Authorization
    header_up -X-TeamGrid-Region
    header_up -X-TeamGrid-Cell-ID
    transport http {
      dial_timeout 3s
      response_header_timeout 35s
      read_timeout 35s
    }
  }`
  const publicPaths = [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/oauth/authorize',
    '/oauth/continue',
    '/oauth/resume',
    '/oauth/token',
    '/oauth/revoke',
  ].join(' ')
  const caddySite = `${host} {
  # Require the managed global URI/header redaction block before admitting this site.
  @private path /internal/oauth/browser/details /internal/oauth/browser/select
  handle @private {
    @trusted {
      method POST
      remote_ip ${specification.browserServiceIps.join(' ')}
    }
    handle @trusted {
      request_body {
        max_size 16384
      }
      ${proxy}
    }
    respond 403
  }
  @mcp path /mcp
  handle @mcp {
    request_body {
      max_size 8388608
    }
    ${proxy}
  }
  @oauth path ${publicPaths}
  handle @oauth {
    request_body {
        max_size 16384
      }
    ${proxy}
  }
  # Liveness/readiness and every other internal or unknown path stay private.
  respond 404
}
`
  const caddyNetwork = {
    services: { caddy: { networks: { default: {}, federation_ingress: {} } } },
    networks: { federation_ingress: { external: true, name: ingress } },
  }
  return { compose, caddySite, caddyNetwork }
}
