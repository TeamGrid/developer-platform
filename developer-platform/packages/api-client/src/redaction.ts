const teamGridCredentialPattern =
  /\b(?:tg_sk_v1|tg_pat_v2|tg_sa_v2)_[a-z0-9-]+_[a-z0-9-]+_[a-f0-9]{24}_[a-f0-9]{64}\b/gi
const webhookSecretPattern = /\bwhsec_v2_[A-Za-z0-9_-]{43}\b/g
const authorizationHeaderPattern = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi
const sensitiveQueryPattern =
  /([?&#](?:authorization(?:[-_]?code)?|code[-_]?verifier|request[-_]?secret|state|token|secret|api[-_]?key|access[-_]?token)=[^&#\s]*)/gi
const sensitiveAssignmentPattern =
  /(\b(?:authorization(?:[-_]?code)?|code[-_]?verifier|request[-_]?secret|state|token|secret|api[-_]?key|access[-_]?token)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]+/gi

export function redactDeveloperSecrets(value: unknown) {
  return String(value ?? '')
    .replace(teamGridCredentialPattern, '[redacted]')
    .replace(webhookSecretPattern, '[redacted]')
    .replace(authorizationHeaderPattern, '$1 [redacted]')
    .replace(sensitiveQueryPattern, (match) => {
      const separator = match.indexOf('=')
      return `${match.slice(0, separator + 1)}[redacted]`
    })
    .replace(sensitiveAssignmentPattern, '$1[redacted]')
}
