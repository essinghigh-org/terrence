#!/usr/bin/env python3
"""Fetch an official tfpolicy-plugin for authorized, isolated compatibility tests.

This verifies provenance, not license rights. Do not redistribute the archive or
executable. The caller must review the applicable HashiCorp terms before use.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import zipfile


RELEASES = 'https://releases.hashicorp.com/tfpolicy-plugin'
KEY_URL = 'https://www.hashicorp.com/.well-known/pgp-key.txt'
KEY_FINGERPRINT = 'C874011F0AB405110D02105534365D9472D7468F'
PINNED_VERSION = '0.5.0'
PINNED_ARCHIVE_SHA256 = '8b4e24766f8f41c0a5fc506feea663aa347c4cb236554cc79cc815daabcb3cde'
STABLE_VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def latest_version(index):
    # Never follow a URL from the index, or silently fall back to an older
    # release if the newest stable version lacks a compatible Linux build.
    versions = [version for version in index['versions'] if STABLE_VERSION.fullmatch(version)]
    if index['name'] != 'tfpolicy-plugin' or not versions:
        raise ValueError('official index contains no stable tfpolicy-plugin release')
    return max(versions, key=lambda version: tuple(map(int, version.split('.'))))


def archive_checksum(sums, filename):
    matches = []
    for line in sums.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == filename:
            if not re.fullmatch('[0-9a-f]{64}', parts[0]):
                raise ValueError('invalid SHA256SUMS digest')
            matches.append(parts[0])
    if len(matches) != 1:
        raise ValueError('expected exactly one matching archive in signed SHA256SUMS')
    return matches[0]


def fetch(url, path, max_bytes=134217728):
    subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location',
                    '--retry', '3', '--connect-timeout', '15', '--max-time', '120',
                    '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2',
                    '--max-filesize', str(max_bytes), '--output', str(path), url], check=True)


def verify_signature(key, signature, sums, home):
    command = ['gpg', '--batch', '--no-options', '--no-autostart', '--homedir', str(home)]
    listing = subprocess.run(command + ['--with-colons', '--show-keys', str(key)],
                             check=True, text=True, capture_output=True).stdout
    primary = []
    previous = ''
    for line in listing.splitlines():
        fields = line.split(':')
        if fields[0] == 'fpr' and previous == 'pub':
            primary.append(fields[9])
        previous = fields[0]
    if primary != [KEY_FINGERPRINT]:
        raise ValueError('HashiCorp signing key changed; explicit review is required')
    keyring = home/'hashicorp.gpg'
    subprocess.run(command + ['--dearmor', '--output', str(keyring), str(key)], check=True, capture_output=True)
    result = subprocess.run(command + ['--no-default-keyring', '--keyring', str(keyring),
                                      '--status-fd=1', '--verify', str(signature), str(sums)],
                            check=True, text=True, capture_output=True)
    valid = [line.split() for line in result.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
    if len(valid) != 1 or valid[0][-1] != KEY_FINGERPRINT:
        raise ValueError('release checksums were not signed by the pinned HashiCorp key')


def extract_archive(archive, destination):
    # Extract only reviewed root files, without trusting ZIP paths or modes.
    allowed = {'tfpolicy-plugin', 'EULA.txt', 'TermsOfEvaluation.txt'}
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        if len(entries) != len(allowed) or {entry.filename for entry in entries} != allowed:
            raise ValueError('unexpected archive layout; review the release before use')
        for entry in entries:
            mode = entry.external_attr >> 16
            limit = 128 * 1024 * 1024 if entry.filename == 'tfpolicy-plugin' else 1024 * 1024
            if entry.is_dir() or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or not 0 < entry.file_size <= limit:
                raise ValueError('archive entries must be bounded regular files')
        for entry in entries:
            path = destination/entry.filename
            with path.open('xb') as stream:
                stream.write(zipped.read(entry))
            path.chmod(0o555 if entry.filename == 'tfpolicy-plugin' else 0o444)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', choices=['pinned', 'latest'], required=True)
    parser.add_argument('--output', type=Path, required=True, help='new private directory')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(mode=0o700)
    version = PINNED_VERSION
    if args.release == 'latest':
        index = output/'index.json'
        fetch(RELEASES+'/index.json', index, 10 * 1024 * 1024)
        version = latest_version(json.loads(index.read_text()))
    filename = f'tfpolicy-plugin_{version}_linux_amd64.zip'
    base = f'{RELEASES}/{version}'
    sums = output/f'tfpolicy-plugin_{version}_SHA256SUMS'
    signature = output/(sums.name+'.sig')
    key = output/'hashicorp.asc'
    fetch(base+'/'+sums.name, sums, 1024 * 1024)
    fetch(base+'/'+signature.name, signature, 1024 * 1024)
    fetch(KEY_URL, key, 1024 * 1024)
    with tempfile.TemporaryDirectory(prefix='tfp-gpg-') as temporary:
        verify_signature(key, signature, sums, Path(temporary))
    expected = archive_checksum(sums.read_text(), filename)
    if args.release == 'pinned' and expected != PINNED_ARCHIVE_SHA256:
        raise ValueError('pinned release changed; explicit review is required')
    archive = output/filename
    fetch(base+'/'+filename, archive)
    if digest(archive) != expected:
        raise ValueError('official archive does not match its signed checksum')
    extract_archive(archive, output)
    provenance = {
        'schemaVersion': 1, 'selection': args.release, 'version': version,
        'platform': 'linux_amd64', 'archiveUrl': base+'/'+filename,
        'archiveSha256': expected, 'executableSha256': digest(output/'tfpolicy-plugin'),
        'signingKeyFingerprint': KEY_FINGERPRINT,
        'termsSha256': {name: digest(output/name) for name in ['EULA.txt', 'TermsOfEvaluation.txt']},
    }
    (output/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
    # Fixed field names and semver-only versions are safe for GITHUB_OUTPUT.
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write(f'version={version}\narchive={archive}\nplugin={output / "tfpolicy-plugin"}\nsha256={provenance["executableSha256"]}\n')
    print(json.dumps(provenance))


if __name__ == '__main__':
    os.umask(0o077)
    main()
