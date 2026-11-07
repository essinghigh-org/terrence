import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from fetch_plugin import archive_checksum, extract_archive, KEY_FINGERPRINT, latest_version, verify_signature


class ReleaseSelectionTest(unittest.TestCase):
    def test_latest_is_numeric_stable_not_index_order(self):
        self.assertEqual('0.10.0', latest_version({'name': 'tfpolicy-plugin', 'versions': {
            '0.9.0': {}, '1.0.0-rc1': {}, '0.10.0': {}, '99.0.0+metadata': {},
            '../../1.0.0': {}, '01.0.0': {}, '0.5.0': {},
        }}))

    def test_no_stable_or_wrong_product_fails(self):
        for name, versions in [('terraform', {'1.0.0': {}}), ('tfpolicy-plugin', {'1.0.0-beta': {}})]:
            with self.assertRaises(ValueError):
                latest_version({'name': name, 'versions': versions})

    def test_checksum_requires_one_exact_filename(self):
        name = 'tfpolicy-plugin_0.5.0_linux_amd64.zip'
        line = 'a'*64+'  '+name
        self.assertEqual('a'*64, archive_checksum(line+'\n'+'b'*64+'  other.zip', name))
        for sums in ['', line+'\n'+line, line.replace('linux_amd64', 'linux_arm64'), 'invalid  '+name]:
            with self.assertRaises(ValueError):
                archive_checksum(sums, name)


class SignatureTest(unittest.TestCase):
    def verify(self, listing, status, returncode=0):
        def run(command, **kwargs):
            if '--show-keys' in command:
                return subprocess.CompletedProcess(command, 0, listing)
            if '--dearmor' in command:
                return subprocess.CompletedProcess(command, 0, '')
            if returncode:
                raise subprocess.CalledProcessError(returncode, command)
            return subprocess.CompletedProcess(command, 0, status)
        with patch('fetch_plugin.subprocess.run', side_effect=run):
            verify_signature(Path('key'), Path('sig'), Path('sums'), Path('home'))

    def test_signature_requires_pinned_primary_and_valid_signature(self):
        listing = 'pub:::::::::\nfpr:::::::::'+KEY_FINGERPRINT+':\n'
        valid = '[GNUPG:] VALIDSIG SUBKEY 2026-11-07 1 0 4 0 1 8 00 '+KEY_FINGERPRINT+'\n'
        self.verify(listing, valid)
        for keys, status in [(listing.replace(KEY_FINGERPRINT, '0'*40), valid),
                             (listing+listing, valid), (listing, ''),
                             (listing, valid.replace(KEY_FINGERPRINT, '0'*40))]:
            with self.assertRaises(ValueError):
                self.verify(keys, status)
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify(listing, valid, returncode=1)


class ArchiveTest(unittest.TestCase):
    def archive(self, root, extra=None, plugin_mode=stat.S_IFREG | 0o755):
        archive = root/'release.zip'
        with zipfile.ZipFile(archive, 'w') as zipped:
            entry = zipfile.ZipInfo('tfpolicy-plugin')
            entry.external_attr = plugin_mode << 16
            zipped.writestr(entry, b'not executable test data')
            for name in ['EULA.txt', 'TermsOfEvaluation.txt']:
                zipped.writestr(name, 'test terms')
            if extra:
                zipped.writestr(extra, 'unexpected')
        return archive

    def test_preserves_terms_and_readonly_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            extract_archive(self.archive(root), root)
            self.assertEqual(0o555, (root/'tfpolicy-plugin').stat().st_mode & 0o777)
            self.assertEqual('test terms', (root/'EULA.txt').read_text())

    def test_rejects_paths_duplicates_symlinks_and_changed_layout(self):
        for extra, mode in [('../escape', stat.S_IFREG), ('unexpected.txt', stat.S_IFREG),
                            (None, stat.S_IFLNK | 0o777)]:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                with self.assertRaises(ValueError):
                    extract_archive(self.archive(root, extra, mode), root)
                self.assertFalse((root/'tfpolicy-plugin').exists())


@unittest.skipIf(os.getuid() == 0, 'real-owner intentionally refuses root')
class HarnessVersionTest(unittest.TestCase):
    def test_release_version_reaches_hosted_profile_with_clean_environment(self):
        # A fake Bun records only the CLI's profile contract. No plugin, API or
        # owner is executed. This catches stale 0.5.0 labels and setup-bun PATH loss.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bun = root/'bun'
            fake_bun.write_text('''#!/usr/bin/python3
import json, os, pathlib, sys
api = pathlib.Path(sys.argv[2])
profile = json.loads(pathlib.Path(os.environ['TERRENCE_TFPOLICY_RUNTIME_PROFILE']).read_text())
assert 'GITHUB_TOKEN' not in os.environ
assert 'HTTPS_PROXY' not in os.environ
(api/'summary.json').write_text(json.dumps({'pluginVersion': profile['pluginVersion'], 'cases': sys.argv[3]}))
''')
            fake_bun.chmod(0o700)
            binary = root/'unused-binary'
            binary.write_bytes(b'not executable')
            profile = root/'profile.json'
            profile.write_text(json.dumps({'runtime': {'runner': {'path': str(binary)}}}))
            command = ['python3', str(Path(__file__).with_name('real-owner.py')),
                       '--owner', str(binary), '--profile', str(profile), '--plugin', str(binary),
                       '--plugin-sha256', hashlib.sha256(binary.read_bytes()).hexdigest(),
                       '--plugin-version', '9.10.0', '--plugin-archive', str(binary),
                       '--repository', str(root), '--output', str(root/'result'),
                       '--cgroup-root', '/unused', '--hosted-worker', '--cases', 'auto-apply,worker-death']
            env = {**os.environ, 'PATH': str(root)+':/usr/bin:/bin',
                   'GITHUB_TOKEN': 'test-must-not-inherit', 'HTTPS_PROXY': 'test-must-not-inherit'}
            subprocess.run(command, check=True, env=env, capture_output=True, timeout=15)
            self.assertEqual({'pluginVersion': '9.10.0', 'cases': 'auto-apply,worker-death'},
                             json.loads((root/'result/summary.json').read_text()))


if __name__ == '__main__':
    unittest.main()
