import { describe, expect, it } from 'vitest'
import { redactDeveloperSecrets } from './redaction.js'

const canaries = {
  authorizationCode: `auth-code-${'a'.repeat(48)}`,
  codeVerifier: `verifier-${'b'.repeat(48)}`,
  legacyV0: 'V0Canary9wK4mT2pR7xQ6zN8a',
  legacyV1: `tg_sk_v1_de_de-nbg-001_${'c'.repeat(24)}_${'d'.repeat(64)}`,
  personalAccess: `tg_pat_v2_de_de-nbg-001_${'e'.repeat(24)}_${'f'.repeat(64)}`,
  requestSecret: `request-secret-${'g'.repeat(48)}`,
  serviceAccount: `tg_sa_v2_us_us-mnz-001_${'a'.repeat(24)}_${'b'.repeat(64)}`,
  state: `state-${'c'.repeat(48)}`,
  webhookSigning: `whsec_v2_${'d'.repeat(43)}`,
}

describe('Developer Platform secret redaction', () => {
  it('redacts supported credentials and short-lived browser authorization values', () => {
    const source = [
      `Authorization: Bearer ${canaries.legacyV0}`,
      canaries.legacyV1,
      canaries.personalAccess,
      canaries.serviceAccount,
      canaries.webhookSigning,
      `?authorization_code=${canaries.authorizationCode}`,
      `code_verifier=${canaries.codeVerifier}`,
      `#request_secret=${canaries.requestSecret}`,
      `{"state":"${canaries.state}"}`,
    ].join('\n')
    const redacted = redactDeveloperSecrets(source)

    for (const secret of Object.values(canaries)) expect(redacted).not.toContain(secret)
    expect(redacted).toContain('[redacted]')
  })
})
