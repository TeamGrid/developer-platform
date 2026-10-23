// Hash every application/dependency byte, ownership/mode and symbolic-link target.
// Node and operating-system files live outside this tree and are patched deliberately.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const root = '/opt/teamgrid/developer-platform';
const entries = [];
function walk(relative) {
  const full = path.join(root, relative);
  const s = fs.lstatSync(full);
  const entry = { path: relative, mode: s.mode, uid: s.uid, gid: s.gid };
  if (s.isSymbolicLink()) entry.link = fs.readlinkSync(full);
  else if (s.isFile()) entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  else if (!s.isDirectory()) throw new Error('Unexpected application tree entry');
  entries.push(entry);
  if (s.isDirectory()) for (const child of fs.readdirSync(full).sort()) walk(path.join(relative, child));
}
walk('');
console.log(JSON.stringify({ contract: 'teamgrid-legacy-mcp-application-tree-v1',
  entries: entries.length, sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') }));
