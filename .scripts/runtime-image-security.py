#!/usr/bin/env python3
"""Scan an immutable local image before publication; retain a bound SBOM/receipt.

Library MEDIUM/HIGH/CRITICAL findings block even without a published fix. Vendor OS
findings with available HIGH/CRITICAL fixes block; unresolved vendor entries
remain visible in the receipt and never become a zero-vulnerability claim.
No secret-bearing Docker Config or environment values enter the artifacts.
"""
import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import urllib.request

CONTRACT = 'teamgrid-runtime-image-security-v1'
RANK = {'UNKNOWN': 0, 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3, 'CRITICAL': 4}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def call(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=kwargs.pop('timeout', 90), **kwargs).stdout


def verify_scan(report, database, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    updated = dt.datetime.fromisoformat(database['UpdatedAt'].replace('Z', '+00:00'))
    age = (now - updated).total_seconds()
    if not -300 <= age <= 24 * 3600:
        raise ValueError('Vulnerability database is stale or has a future timestamp')
    system = report.get('Metadata', {}).get('OS')
    if not system or system.get('Family') in (None, '', 'none') or system.get('EOSL'):
        raise ValueError('Supported operating system was not identified')
    results = report.get('Results')
    if not isinstance(results, list) or not results:
        raise ValueError('Scanner produced no package results')
    if any(r.get('Class') not in ('os-pkgs', 'lang-pkgs') for r in results):
        raise ValueError('Unsupported scanner result class')
    if not any(r.get('Class') == 'os-pkgs' and r.get('Packages') for r in results):
        raise ValueError('Scanner produced no operating-system package inventory')
    package_count = sum(len(r.get('Packages', [])) for r in results)
    if package_count < 1:
        raise ValueError('Scanner detected no packages')
    blocking, unresolved, findings = [], [], []
    for result in results:
        kind = result.get('Class')
        if kind not in ('os-pkgs', 'lang-pkgs'):
            continue
        for item in result.get('Vulnerabilities', []):
            if item.get('Severity') not in RANK:
                raise ValueError('Unknown vulnerability severity')
            row = {k: item.get(k) for k in ('VulnerabilityID', 'PkgName', 'PkgPath',
                   'InstalledVersion', 'FixedVersion', 'Severity', 'Status', 'Title', 'PrimaryURL')}
            row.update(type=result.get('Type'), target=result.get('Target'), category=kind)
            severity = RANK[row['Severity']]
            is_blocking = (kind == 'lang-pkgs' and
                           severity >= RANK['MEDIUM'])
            is_blocking = is_blocking or (kind == 'os-pkgs' and
                                          severity >= RANK['HIGH'] and row['FixedVersion'])
            if is_blocking:
                blocking.append(row)
            elif kind == 'os-pkgs' and severity >= RANK['HIGH']:
                unresolved.append(row)
            findings.append(row)
    return {'os': system, 'packagesDetected': package_count, 'blockingFindings': blocking,
            'unresolvedVendorOsFindings': unresolved, 'allFindings': findings,
            'databaseUpdatedAtUtc': database['UpdatedAt']}


def scanner(tooling, tools):
    tools.mkdir(parents=True, exist_ok=True)
    binary = tools / 'trivy'
    if binary.exists():
        if binary.is_symlink() or digest(binary.read_bytes()) != tooling['binarySha256']:
            raise ValueError('Cached scanner binary identity differs')
        return binary
    request = urllib.request.Request(tooling['archiveUrl'], headers={'User-Agent': CONTRACT})
    with urllib.request.urlopen(request, timeout=90) as response:
        raw = response.read(128 * 1024 * 1024 + 1)
    if digest(raw) != tooling['archiveSha256']:
        raise ValueError('Scanner archive checksum differs')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        member = archive.getmember('trivy')
        if not member.isfile() or member.size > 256 * 1024 * 1024:
            raise ValueError('Invalid scanner archive entry')
        content = archive.extractfile(member).read()
    if digest(content) != tooling['binarySha256']:
        raise ValueError('Scanner binary checksum differs')
    binary.write_bytes(content)
    binary.chmod(0o700)
    return binary


def finalize_publication(args):
    receipt_path = args.output / 'receipt.json'
    receipt = json.loads(receipt_path.read_text())
    if (receipt.get('status') not in ('passed', 'passed-with-unresolved-vendor-findings')
            or receipt.get('sourceSha') != args.source_sha
            or receipt.get('component') != args.component):
        raise ValueError('Publication has no successful matching scan')
    for name, key in [('sbom.cdx.json', 'sbomSha256'), ('vulnerabilities.json', 'vulnerabilitiesSha256')]:
        if digest((args.output / name).read_bytes()) != receipt.get(key):
            raise ValueError('Scanned publication evidence changed')
    reference = args.finalize_publication
    if not re.fullmatch(r'ghcr\.io/teamgrid/[a-z0-9-]+:' + args.source_sha, reference):
        raise ValueError('Publication must use the exact source SHA tag')
    if call(['docker', 'image', 'inspect', '--format', '{{.Id}}', args.image]).strip() != receipt['imageId']:
        raise ValueError('Local scanned image changed')
    call(['docker', 'pull', reference], timeout=300)
    published = json.loads(call(['docker', 'image', 'inspect', reference]))[0]
    if published['Id'] != receipt['imageId']:
        raise ValueError('Published image differs from scanned image')
    repository = reference.rsplit(':', 1)[0]
    refs = [r for r in published.get('RepoDigests', [])
            if re.fullmatch(re.escape(repository) + r'@sha256:[a-f0-9]{64}', r)]
    if len(refs) != 1:
        raise ValueError('Unique published immutable digest unavailable')
    receipt.update(publishedImage=refs[0], publishedTag=reference,
                   publicationVerifiedAtUtc=dt.datetime.now(dt.timezone.utc).isoformat())
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'component': args.component, 'publishedImage': refs[0], 'imageId': receipt['imageId']}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--component', required=True)
    parser.add_argument('--source-label', default='org.opencontainers.image.revision', choices=['org.opencontainers.image.revision', 'com.teamgrid.dependency-security-build-revision'])
    parser.add_argument('--node-runtime')
    parser.add_argument('--finalize-publication', help='Exact SHA-tagged repository reference, verified after push')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tooling', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}', args.source_sha):
        raise ValueError('Exact source SHA required')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', args.component):
        raise ValueError('Invalid component name')
    args.output.mkdir(parents=True, exist_ok=True)
    receipt_path = args.output / 'receipt.json'
    receipt = {'contract': CONTRACT, 'component': args.component, 'sourceSha': args.source_sha,
               'createdAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'status': 'scan-error'}
    if args.finalize_publication:
        finalize_publication(args)
        return
    raw_path = args.output / '.scan-private.json'
    try:
        image = json.loads(call(['docker', 'image', 'inspect', args.image]))[0]
        image_id = image['Id']
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
            raise ValueError('Immutable image ID unavailable')
        if image['Config'].get('Labels', {}).get(args.source_label) != args.source_sha:
            raise ValueError('Image source label differs from intended source')
        receipt.update(imageId=image_id, architecture=image['Architecture'], os=image['Os'],
                       rootFsSha256=digest(json.dumps(image['RootFS'], sort_keys=True).encode()),
                       imageConfigSha256=digest(json.dumps(image['Config'], sort_keys=True).encode()))
        if args.node_runtime:
            if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', args.node_runtime):
                raise ValueError('Exact Node runtime required')
            probe = ("const fs=require('fs');if(process.version!=='v'+process.argv[1])throw Error('Node runtime differs');"
                     "for(const p of ['/usr/local/lib/node_modules/npm','/usr/local/lib/node_modules/corepack',"
                     "'/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/yarn','/usr/local/bin/yarnpkg'])"
                     "{if(fs.existsSync(p))throw Error('Build package manager in final runtime: '+p)}"
                     "process.stdout.write(JSON.stringify({node:process.version,globalPackageManagersAbsent:true}));")
            receipt['nodeRuntime'] = json.loads(call(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                                                     '--entrypoint', '/usr/local/bin/node', image_id,
                                                     '-e', probe, args.node_runtime], timeout=30))
        tooling = json.loads(args.tooling.read_text())
        binary = scanner(tooling, args.cache / 'tools')
        receipt['scanner'] = {'version': tooling['version'], 'binarySha256': tooling['binarySha256']}
        environment = {**os.environ, 'GOMAXPROCS': '2', 'GOMEMLIMIT': '4GiB'}
        base = [str(binary), '--cache-dir', str(args.cache / 'db-cache')]
        logs = []
        for action in (['image', '--download-db-only'], ['image', '--download-java-db-only']):
            logs.append(call([*base, *action, '--disable-telemetry', '--skip-version-check', '--no-progress'],
                             env=environment, timeout=300))
        database = json.loads((args.cache / 'db-cache/db/metadata.json').read_text())
        call([*base, 'image', '--image-src', 'docker', image_id,
              '--disable-telemetry', '--skip-version-check', '--skip-db-update', '--skip-java-db-update',
              '--offline-scan', '--list-all-pkgs', '--scanners', 'vuln', '--parallel', '2', '--timeout', '20m',
              '--no-progress', '--format', 'json', '--output', str(raw_path)],
             env=environment, timeout=1260)
        raw_path.chmod(0o600)
        report = json.loads(raw_path.read_text())
        assessment = verify_scan(report, database)
        filtered = args.output / 'vulnerabilities.json'
        filtered.write_text(json.dumps(assessment, indent=2) + '\n')
        call([*base, 'convert', '--format', 'cyclonedx', '--output',
              str(args.output / 'sbom.cdx.json'), str(raw_path)], env=environment, timeout=120)
        sbom = json.loads((args.output / 'sbom.cdx.json').read_text())
        if sbom.get('bomFormat') != 'CycloneDX' or not sbom.get('components'):
            raise ValueError('Scanner produced no CycloneDX package inventory')
        receipt.update(status='blocked' if assessment['blockingFindings'] else
                       ('passed-with-unresolved-vendor-findings' if assessment['unresolvedVendorOsFindings'] else 'passed'),
                       packagesDetected=assessment['packagesDetected'], operatingSystem=assessment['os'],
                       databaseUpdatedAtUtc=assessment['databaseUpdatedAtUtc'],
                       blockingFindingCount=len(assessment['blockingFindings']),
                       unresolvedVendorFindingCount=len(assessment['unresolvedVendorOsFindings']),
                       rawScanSha256=digest(raw_path.read_bytes()),
                       vulnerabilitiesSha256=digest(filtered.read_bytes()),
                       sbomSha256=digest((args.output / 'sbom.cdx.json').read_bytes()))
        if assessment['blockingFindings']:
            raise ValueError('Runtime image has ' + str(len(assessment['blockingFindings'])) + ' blocking findings; see vulnerabilities.json')
    except Exception as error:
        receipt['error'] = str(error)
        raise
    finally:
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
        raw_path.unlink(missing_ok=True)
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
