import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { TeamGridClientError } from '@teamgrid/api-client'

export type CredentialCommandResult = {
  stderr: string
  stdout: string
}

export type CredentialCommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<CredentialCommandResult>

export interface CredentialStore {
  delete(profile: string): Promise<void>
  get(profile: string): Promise<string | null>
  set(profile: string, token: string): Promise<void>
}

const serviceName = 'teamgrid-cli'
const maxOutputBytes = 16 * 1024
const windowsCredentialManagerType = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class TeamGridCredentialManager
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, UInt32 flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(
        string target,
        UInt32 type,
        UInt32 reservedFlag,
        out IntPtr credentialPtr
    );

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("Advapi32.dll", SetLastError = false)]
    private static extern void CredFree(IntPtr buffer);

    public static void Write(string target, string secret)
    {
        byte[] bytes = Encoding.Unicode.GetBytes(secret);
        if (bytes.Length == 0 || bytes.Length > 2560)
            throw new ArgumentException("Credential length is invalid.");
        IntPtr blob = Marshal.AllocCoTaskMem(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            Credential credential = new Credential
            {
                AttributeCount = 0,
                Attributes = IntPtr.Zero,
                Comment = "TeamGrid CLI credential",
                CredentialBlob = blob,
                CredentialBlobSize = (UInt32)bytes.Length,
                Flags = 0,
                Persist = 2,
                TargetName = target,
                Type = 1,
                UserName = Environment.UserName
            };
            if (!CredWrite(ref credential, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            Marshal.FreeCoTaskMem(blob);
        }
    }

    public static string Read(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 1168) return null;
            throw new Win32Exception(error);
        }
        try
        {
            Credential credential = (Credential)Marshal.PtrToStructure(
                pointer,
                typeof(Credential)
            );
            if (credential.CredentialBlob == IntPtr.Zero ||
                credential.CredentialBlobSize == 0) return null;
            byte[] bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            try
            {
                return Encoding.Unicode.GetString(bytes);
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
            }
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static bool Delete(string target)
    {
        if (CredDelete(target, 1, 0)) return true;
        int error = Marshal.GetLastWin32Error();
        if (error == 1168) return false;
        throw new Win32Exception(error);
    }
}
`

function encodePowerShell(script: string) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function validateCredentialProfile(profile: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new TeamGridClientError('invalid_profile_name', 'The credential profile name is invalid.')
  }
  return profile
}

function darwinCredentialSetScript(profile: string) {
  const safeProfile = validateCredentialProfile(profile)
  return `
set timeout 15
log_user 0
if {[gets stdin secret] < 0 || [string length $secret] == 0} { exit 64 }
spawn -noecho /usr/bin/env LC_ALL=C /usr/bin/security add-generic-password -U -s ${serviceName} -a ${safeProfile} -w
expect {
  -exact "password data for new item:" {}
  timeout { unset secret; exit 124 }
  eof { unset secret; exit 1 }
}
send -- "$secret\r"
expect {
  -exact "retype password for new item:" {}
  timeout { unset secret; exit 124 }
  eof { unset secret; exit 1 }
}
send -- "$secret\r"
expect eof
set result [wait]
set exitCode [lindex $result 3]
unset secret
exit $exitCode
`
}

function windowsCredentialScript(operation: 'delete' | 'get' | 'set', profile: string) {
  const target = `${serviceName}:${validateCredentialProfile(profile)}`
  const operationScript =
    operation === 'get'
      ? `$value = [TeamGridCredentialManager]::Read('${target}')
if ($null -eq $value) { exit 44 }
[Console]::Out.Write($value)`
      : operation === 'set'
        ? `$secret = [Console]::In.ReadToEnd()
$secret = $secret -replace '[\\r\\n]+$', ''
[TeamGridCredentialManager]::Write('${target}', $secret)`
        : `if (-not [TeamGridCredentialManager]::Delete('${target}')) { exit 44 }`
  return encodePowerShell(`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
${windowsCredentialManagerType}
'@
${operationScript}
} catch {
  [Console]::Error.Write('Windows Credential Manager operation failed.')
  exit 1
}
`)
}

function windowsCredentialCommand(
  operation: 'delete' | 'get' | 'set',
  profile: string,
): [string, string[]] {
  return [
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      windowsCredentialScript(operation, profile),
    ],
  ]
}

export function runCredentialCommand(command: string, args: string[], input?: string) {
  return new Promise<CredentialCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxOutputBytes) stdout += chunk.slice(0, maxOutputBytes - stdout.length)
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxOutputBytes) stderr += chunk.slice(0, maxOutputBytes - stderr.length)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stderr, stdout })
      else {
        const error = new Error(`Credential helper exited with status ${code ?? 'unknown'}.`)
        Object.assign(error, { code, stderr })
        reject(error)
      }
    })
    if (input !== undefined) child.stdin.end(`${input}\n`)
    else child.stdin.end()
  })
}

function isMissingCredential(error: unknown) {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & { code?: unknown; stderr?: unknown }
  if (candidate.code === 44 || /status 44\b/.test(candidate.message)) return true
  return (
    (candidate.code === 1 || /status 1\b/.test(candidate.message)) &&
    String(candidate.stderr || '').trim() === ''
  )
}

function credentialStoreUnavailable(error: unknown): never {
  throw new TeamGridClientError(
    'credential_store_unavailable',
    'No supported OS credential store is available. Use TEAMGRID_API_TOKEN for this session.',
    { cause: error },
  )
}

export class SystemCredentialStore implements CredentialStore {
  readonly #platform: NodeJS.Platform
  readonly #run: CredentialCommandRunner

  constructor({
    currentPlatform = platform(),
    run = runCredentialCommand,
  }: {
    currentPlatform?: NodeJS.Platform
    run?: CredentialCommandRunner
  } = {}) {
    this.#platform = currentPlatform
    this.#run = run
  }

  async get(profile: string) {
    try {
      if (this.#platform === 'darwin') {
        const result = await this.#run('security', [
          'find-generic-password',
          '-s',
          serviceName,
          '-a',
          profile,
          '-w',
        ])
        return result.stdout.trim() || null
      }
      if (this.#platform === 'linux') {
        const result = await this.#run('secret-tool', [
          'lookup',
          'service',
          serviceName,
          'profile',
          profile,
        ])
        return result.stdout.trim() || null
      }
      if (this.#platform === 'win32') {
        const [command, args] = windowsCredentialCommand('get', profile)
        const result = await this.#run(command, args)
        return result.stdout.trim() || null
      }
      return credentialStoreUnavailable(new Error(`Unsupported platform ${this.#platform}.`))
    } catch (error) {
      if (isMissingCredential(error)) return null
      return credentialStoreUnavailable(error)
    }
  }

  async set(profile: string, token: string) {
    try {
      if (this.#platform === 'darwin') {
        await this.#run('/usr/bin/expect', ['-c', darwinCredentialSetScript(profile)], token)
        return
      }
      if (this.#platform === 'linux') {
        await this.#run(
          'secret-tool',
          ['store', '--label=TeamGrid CLI', 'service', serviceName, 'profile', profile],
          token,
        )
        return
      }
      if (this.#platform === 'win32') {
        const [command, args] = windowsCredentialCommand('set', profile)
        await this.#run(command, args, token)
        return
      }
      credentialStoreUnavailable(new Error(`Unsupported platform ${this.#platform}.`))
    } catch (error) {
      credentialStoreUnavailable(error)
    }
  }

  async delete(profile: string) {
    try {
      if (this.#platform === 'darwin') {
        await this.#run('security', ['delete-generic-password', '-s', serviceName, '-a', profile])
        return
      }
      if (this.#platform === 'linux') {
        await this.#run('secret-tool', ['clear', 'service', serviceName, 'profile', profile])
        return
      }
      if (this.#platform === 'win32') {
        const [command, args] = windowsCredentialCommand('delete', profile)
        await this.#run(command, args)
        return
      }
      credentialStoreUnavailable(new Error(`Unsupported platform ${this.#platform}.`))
    } catch (error) {
      if (isMissingCredential(error)) return
      credentialStoreUnavailable(error)
    }
  }
}
