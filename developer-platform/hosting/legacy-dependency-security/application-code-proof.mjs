// This proof deliberately covers compiled application bytes, not patched dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const root = '/opt/teamgrid/developer-platform';
const entries = [];
function walk(relative) {
  const full = path.join(root, relative);
  const stat = fs.lstatSync(full);
  const entry = { path: relative, mode: stat.mode, uid: stat.uid, gid: stat.gid };
  if (stat.isSymbolicLink()) entry.link = fs.readlinkSync(full);
  else if (stat.isFile()) entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  else if (!stat.isDirectory()) throw new Error('Unexpected application code entry');
  entries.push(entry);
  if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) walk(path.join(relative, name));
}
for (const name of ['api-client', 'cli', 'mcp-server']) walk('packages/' + name + '/dist');
for (const name of ['api-client', 'cli']) walk('packages/' + name + '/package.json');
console.log(JSON.stringify({contract: 'teamgrid-legacy-mcp-application-code-v1', entries: entries.length,
  sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')}));
