#!/usr/bin/env python3
"""Local-only BYOB acceptance through the protected owner, never production activation.

Requires already prepared non-root/zero-capability execution and a delegated
cgroup. Uses only terraform_data and an isolated real Terrence API/database.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import ssl
import subprocess
import tempfile
import time
import urllib.request


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)


def pending_resource(private):
    for path in private.glob('r-*/journal'):
        pending = set()
        try:
            for line in path.read_bytes().splitlines():
                row = json.loads(line)
                if row['method'] == 'EvaluateResource':
                    if row['phase'] == 'begin':
                        pending.add(row['id'])
                    else:
                        pending.discard(row['id'])
        except (ValueError, KeyError):
            continue
        if pending:
            return True
    return False


def kill_owned_plugin(cgroup_root, plugin):
    for group in cgroup_root.glob('tfpolicy-*'):
        try:
            pids = (group/'cgroup.procs').read_text().split()
        except FileNotFoundError:
            continue
        for text in pids:
            pid = int(text)
            descriptor = None
            try:
                descriptor = os.pidfd_open(pid)
                if os.readlink(f'/proc/{pid}/exe') == str(plugin):
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    return True
            except (ProcessLookupError, FileNotFoundError):
                pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)
    return False


def stage(args, config, output, private, interrupt=None):
    output.mkdir(mode=0o700)
    config_path = output/'owner-config.json'
    private_json(config_path, config)
    child = subprocess.Popen([str(args.owner), 'execute', '--config', str(config_path)],
                             env={'PATH': '/usr/bin:/bin'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    exercised = interrupt is None
    try:
        until = time.monotonic()+40
        while child.poll() is None and time.monotonic()<until:
            if not exercised and pending_resource(private):
                if interrupt == 'cancel':
                    child.send_signal(signal.SIGTERM)
                    exercised = True
                else:
                    exercised = kill_owned_plugin(Path(config['cgroupRoot']), args.plugin)
            time.sleep(.002)
        stdout, stderr = child.communicate(timeout=10)
        (output/'owner.stdout').write_bytes(stdout)
        (output/'owner.stderr').write_bytes(stderr)
        result = json.loads(stdout)
        if not exercised:
            raise RuntimeError('negative control never reached an in-flight native resource RPC')
        directory = Path(result.get('directory', ''))
        if directory.is_relative_to(private) and directory.is_dir():
            for name in ['stdout', 'stderr', 'audit', 'journal', 'journal.status.json', 'plan.json']:
                path = directory/name
                if path.is_file():
                    shutil.copyfile(path, output/name)
            if (directory/'recorder.json').exists():
                raise RuntimeError('private recorder credential configuration was retained')
        if not result.get('cgroupEmpty'):
            raise RuntimeError('owner did not prove empty process-tree cleanup')
        return child.returncode, result
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=12)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        config_path.unlink(missing_ok=True)


def matrix(args, runtime, context):
    rows = []
    modes = ['allow', 'metadata', 'relocated', 'filtered', 'advisory', 'override', 'deny', 'unknown', 'setup-error', 'missing', 'crash', 'cancel']
    modes += ['init-mixed-'+level+'-'+order for level in ['mandatory', 'overridable'] for order in ['deny-first', 'unknown-first']]
    if args.cases:
        selected = args.cases.split(',')
        if any(mode not in modes for mode in selected):
            raise RuntimeError('unknown real-owner acceptance case')
        modes = selected
    for mode in modes:
        output = args.output/mode
        output.mkdir(mode=0o700)
        with tempfile.TemporaryDirectory(prefix='tfpr-', dir='/tmp') as temporary:
            root = Path(temporary)
            work, policy, private = [root/name for name in ['w', 'p', 's']]
            for path in [work, policy, private]:
                path.mkdir(mode=0o700)
            count = ' count = 1000\n' if mode in ['crash', 'cancel'] else ''
            (work/'main.tf').write_text('resource "terraform_data" "proof" {\n'+count+' input = "local-only"\n}\n')
            if mode == 'metadata':
                (work/'main.tf').write_text('provider "terraform" { alias = "secondary" }\nresource "terraform_data" "proof" {\n provider = terraform.secondary\n input = "local-only"\n}\nmodule "child" {\n source = "./child"\n count = 2\n}\nmodule "empty" {\n source = "./empty"\n count = 0\n}\n')
                for name in ['child', 'inner', 'empty']:
                    (work/name).mkdir(mode=0o700)
                (work/'child/main.tf').write_text('resource "terraform_data" "child" { input = "local-only" }\nmodule "inner" { source = "../inner" }\n')
                (work/'inner/main.tf').write_text('resource "terraform_data" "inner" { input = "local-only" }\n')
                (work/'empty/main.tf').write_text('# Empty count-zero local module still requires module policy evaluation.\n')
            condition = 'attrs.input == "local-only"'
            if mode == 'deny':
                condition = 'attrs.input == "forbidden"'
            if mode == 'unknown':
                condition = 'attrs.id == "never"'
            if mode == 'setup-error':
                condition = 'attrs.input =='
            enforcement = 'advisory' if mode == 'advisory' else 'mandatory_overridable' if mode in ['override', 'relocated'] else 'mandatory'
            if mode in ['advisory', 'override', 'relocated']:
                condition = 'attrs.input == "forbidden"'
            source = 'policy {\n required_providers {\n terraform = { source = "terraform.io/builtin/terraform" }\n }\n}\n'
            source += 'resource_policy "terraform_data" "proof" {\n enforcement_level = "'+enforcement+'"\n'
            if mode == 'filtered':
                source += ' filter = false\n'
            source += ' enforce {\n condition = '+condition+'\n error_message = "local acceptance denial"\n }\n}\n'
            if mode.startswith('init-mixed-'):
                (work/'child').mkdir(mode=0o700)
                (work/'child/main.tf').write_text('resource "terraform_data" "child" { input = "local-only" }\n')
                with (work/'main.tf').open('a') as stream:
                    stream.write('module "child" { source = "./child" }\n')
                level = 'mandatory_overridable' if 'overridable' in mode else 'mandatory'
                known = 'module_policy "*" "known" {\n enforcement_level = "'+level+'"\n enforce {\n condition = false\n error_message = "known mandatory init denial"\n }\n}\n'
                unknown = 'module_policy "*" "unknown" {\n enforce {\n condition = attrs.input == "local-only"\n error_message = "required unknown at init"\n }\n}\n'
                source += unknown+known if mode.endswith('unknown-first') else known+unknown
            if mode == 'metadata':
                source += 'provider_policy "terraform" "source" {\n enforce {\n condition = meta.source == "terraform.io/builtin/terraform"\n error_message = "unexpected local provider"\n }\n}\nmodule_policy "*" "local" {\n enforce {\n condition = true\n error_message = "local module denied"\n }\n}\n'
                source += 'resource_policy "terraform_data" "delete" {\n operations = ["delete"]\n enforce {\n condition = prior_attrs.input == "local-only"\n error_message = "unexpected deleted local resource"\n }\n}\n'
            policy_file = policy/'proof.policy.hcl'
            policy_file.write_text(source)
            policy_file.chmod(0o400)
            policy.chmod(0o500)
            config = {'schemaVersion': 1, 'runtime': runtime, 'runId': context['runId'],
                      'workspaceId': context['workspaceId'], 'command': 'init', 'workDirectory': str(work),
                      'privateParent': str(private), 'cgroupRoot': args.cgroup_root,
                      'policyRoots': [str(policy)], 'environment': {}, 'arguments': [],
                      'runContext': context['runContext'], 'timeoutSeconds': 30,
                      'receiptKey': os.urandom(32).hex(), 'evaluationId': 'eval-'+mode,
                      'policyFingerprint': digest(policy_file)}
            if mode == 'missing':
                config['runtime'] = {**runtime, 'plugin': {**runtime['plugin'], 'path': str(private/'missing-plugin')}}
            if mode in ['override', 'relocated']:
                config['overrides'] = [{'file': str(policy_file), 'address': 'resource_policy.terraform_data.proof'}]
            try:
                code, initialized = stage(args, config, output/'init', private)
                if mode.startswith('init-mixed-'):
                    if code == 0 or initialized['exitCode'] == 0 or initialized['evidence']['allows']:
                        raise RuntimeError('known required DENY was deferred with UNKNOWN during native init')
                    audit = [json.loads(line) for line in (output/'init/audit').read_bytes().splitlines()]
                    results = [row for row in audit if row['event'] == 'result' and row.get('target', {}).get('kind') == 'module']
                    if not any(row['result'] == 'denied' and row['failed'] and any(p['result'] == 'DenyResult' for p in row.get('policies', [])) and any(p['result'] == 'UnknownResult' for p in row.get('policies', [])) for row in results):
                        raise RuntimeError('mixed native init control did not reach both known denial and required unknown')
                    manifest = work/'.terraform/modules/modules.json'
                    if manifest.exists() and any(module.get('Key') == 'child' for module in json.loads(manifest.read_text()).get('Modules', [])):
                        raise RuntimeError('known denied module was installed')
                elif mode in ['setup-error', 'missing']:
                    if code == 0 or initialized['verified']:
                        raise RuntimeError('invalid policy Setup authorized execution')
                else:
                    if code != 0 or not initialized['verified'] or not initialized['evidence']['allows']:
                        raise RuntimeError('real plugin strict initialization failed')
                    config['command'] = 'plan'
                    code, planned = stage(args, config, output/'plan', private,
                                          'crash' if mode == 'crash' else 'cancel' if mode == 'cancel' else None)
                    if mode in ['allow', 'metadata', 'relocated', 'filtered', 'advisory', 'override']:
                        if code != 0 or not planned['verified'] or not planned['evidence']['allows']:
                            raise RuntimeError('real positive control failed owner verification')
                        if mode != 'filtered' and not planned['evidence']['policies']:
                            raise RuntimeError('positive control did not evaluate a named policy')
                        if mode == 'metadata':
                            addresses = {policy['address'] for policy in planned['evidence']['policies']}
                            if not {'provider_policy.terraform.source', 'module_policy.*.local'} <= addresses:
                                raise RuntimeError('provider/module policies were not actually matched')
                        config['command'] = 'apply'
                        config['savedPlan'] = {'path': str(Path(planned['directory'])/'tfplan'), 'sha256': planned['planSha256']}
                        config['planReceipt'] = planned['receipt']
                        if mode == 'relocated':
                            moved = root/'new-host-source'
                            moved.mkdir(mode=0o700)
                            shutil.copyfile(policy_file, moved/policy_file.name)
                            (moved/policy_file.name).chmod(0o400)
                            moved.chmod(0o500)
                            config['policyRoots'] = [str(moved)]
                            config['overrides'] = [{'file': str(moved/policy_file.name), 'address': 'resource_policy.terraform_data.proof'}]
                            shim = root/'new-host-shim'
                            shutil.copyfile(Path(runtime['shim']['path']), shim)
                            shim.chmod(0o500)
                            config['runtime'] = {**runtime, 'shim': {'path': str(shim), 'sha256': digest(shim)}}
                        code, applied = stage(args, config, output/'apply', private)
                        if code != 0 or not applied['verified'] or not applied['evidence']['allows']:
                            raise RuntimeError('real saved-plan apply failed owner verification')
                        state = json.loads((work/'terraform.tfstate').read_text())
                        if not any(r.get('instances') for r in state.get('resources', [])):
                            raise RuntimeError('positive apply did not preserve managed state')
                        if mode == 'metadata':
                            # Remove a whole nested module tree. The default
                            # provider is now used only by orphan state; the
                            # retained root resource uses its secondary alias.
                            original = (work/'main.tf').read_text()
                            (work/'main.tf').write_text(original.replace('module "child" {\n source = "./child"\n count = 2\n}\n', ''))
                            config['command'] = 'plan'
                            config.pop('savedPlan', None)
                            config.pop('planReceipt', None)
                            code, removed = stage(args, config, output/'orphan-plan', private)
                            if code != 0 or not removed['verified'] or not removed['evidence']['allows']:
                                raise RuntimeError('removed module/orphan provider plan failed independent coverage')
                            if not any(p['address'] == 'resource_policy.terraform_data.delete' for p in removed['evidence']['policies']):
                                raise RuntimeError('delete policies did not evaluate orphan instances')
                            config['command'] = 'apply'
                            config['savedPlan'] = {'path': str(Path(removed['directory'])/'tfplan'), 'sha256': removed['planSha256']}
                            config['planReceipt'] = removed['receipt']
                            code, deleted = stage(args, config, output/'orphan-apply', private)
                            if code != 0 or not deleted['verified'] or not deleted['evidence']['allows']:
                                raise RuntimeError('removed module/orphan provider apply failed independent coverage')
                            state = json.loads((work/'terraform.tfstate').read_text())
                            if any(r.get('module', '').startswith('module.child') for r in state.get('resources', [])):
                                raise RuntimeError('orphan resource state survived its verified deletion')
                    else:
                        if code == 0 or planned['evidence']['allows']:
                            raise RuntimeError('negative native control authorized execution')
                        if mode == 'deny' and not planned['verified']:
                            raise RuntimeError('known denial lost its verified policy disposition')
                        if mode == 'unknown' and not any(json.loads(line).get('result') == 'unknown' for line in (output/'plan/audit').read_bytes().splitlines()):
                            raise RuntimeError('unknown control did not evaluate a required unknown policy')
                        if mode == 'cancel' and not planned['cancelled']:
                            raise RuntimeError('cancellation was not recorded')
                        if (work/'terraform.tfstate').exists():
                            raise RuntimeError('negative plan unexpectedly wrote managed state')
                rows.append({'case': mode, 'passed': True})
            finally:
                policy.chmod(0o700)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['owner', 'profile', 'plugin', 'output', 'repository']:
        parser.add_argument('--'+key, type=Path, required=True)
    parser.add_argument('--plugin-sha256', required=True)
    parser.add_argument('--plugin-version', default='0.5.0', help='actual release version for catalog and policy selection')
    parser.add_argument('--cgroup-root', required=True)
    parser.add_argument('--hosted-worker', action='store_true', help='exercise production worker plan/apply and persisted policy gates')
    parser.add_argument('--agent-binary', type=Path, help='exercise production agent API and the specified terrence-agent executable')
    parser.add_argument('--agent-runner', type=Path, help='the agent project sandbox helper, required with --agent-binary')
    parser.add_argument('--plugin-archive', type=Path, help='original operator ZIP, required for hosted catalog identity')
    parser.add_argument('--cases', help='comma-separated subset of real-plugin acceptance cases')
    args = parser.parse_args()
    if re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', args.plugin_version) is None:
        raise RuntimeError('plugin version must identify an exact stable release')
    # Resolve setup-bun's executable before clearing the caller's environment.
    # The isolated API must not inherit CI tokens, proxy variables or credentials.
    bun = shutil.which('bun')
    if bun is None:
        raise RuntimeError('Bun must be available on the caller PATH')
    bun = str(Path(bun).resolve(strict=True))
    if os.getuid() == 0 or args.output.exists() or digest(args.plugin) != args.plugin_sha256:
        raise RuntimeError('non-root execution, new output and an independently pinned BYOB executable are required')
    args.output.mkdir(mode=0o700)
    api = args.output/'api'
    api.mkdir(mode=0o700)
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:localhost.localdomain,IP:127.0.0.1',
                    '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', str(api/'server.key'),
                    '-out', str(api/'server.crt')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (api/'server.key').chmod(0o600)
    (api/'server.crt').chmod(0o400)
    trust = api/'server.crt'
    if args.agent_binary is not None:
        # Rustls requires a leaf server certificate, not a CA used as a leaf.
        (api/'ca.crt').write_bytes((api/'server.crt').read_bytes())
        (api/'ca.crt').chmod(0o400)
        (api/'ca.key').write_bytes((api/'server.key').read_bytes())
        (api/'ca.key').chmod(0o600)
        (api/'server.crt').unlink()
        (api/'leaf.conf').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,DNS:localhost.localdomain,IP:127.0.0.1\n')
        subprocess.run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost.localdomain', '-keyout', str(api/'server.key'), '-out', str(api/'server.csr')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['openssl', 'x509', '-req', '-in', str(api/'server.csr'), '-CA', str(api/'ca.crt'), '-CAkey', str(api/'ca.key'), '-CAcreateserial', '-days', '1', '-extfile', str(api/'leaf.conf'), '-out', str(api/'server.crt')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (api/'server.crt').chmod(0o400)
        trust = api/'ca.crt'
    runtime = json.loads(args.profile.read_text())['runtime']
    runtime['plugin'] = {'path': str(args.plugin), 'sha256': args.plugin_sha256}
    runtime['entitlementCA'] = {'path': str(trust), 'sha256': digest(trust)}
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(api), 'DATABASE_URL': 'file:'+str(api/'test.db'),
           'STORAGE_DIR': str(api/'storage'), 'NODE_ENV': 'test', 'TERRENCE_DISABLE_WORKER': '1',
           'TERRENCE_ALLOWED_HOSTS': 'localhost,localhost.localdomain,127.0.0.1'}
    if args.hosted_worker or args.agent_binary is not None:
        if args.plugin_archive is None:
            raise RuntimeError('hosted acceptance requires the operator archive identity')
        with tempfile.TemporaryDirectory(prefix='tfpw-', dir='/tmp') as private:
            profile = {'schemaVersion': 1, 'owner': {'path': str(args.owner), 'sha256': digest(args.owner)},
                       'runtime': runtime, 'pluginVersion': args.plugin_version, 'catalogSha256': digest(args.plugin_archive),
                       'cgroupRoot': args.cgroup_root, 'privateParent': private}
            path = api/'profile.json'
            private_json(path, profile)
            path.chmod(0o400)
            env.update({'TERRENCE_TFPOLICY_RUNTIME_PROFILE': str(path),
                        'TERRENCE_RUN_CGROUP_ROOT': args.cgroup_root,
                        'TERRENCE_LANDLOCK_RUNNER': runtime['runner']['path']})
            script = 'agent.ts' if args.agent_binary is not None else 'worker.ts'
            command = [bun, str(args.repository/'backend/tests/compat/tfpolicy-owner'/script), str(api)]
            if args.agent_binary is not None:
                if args.agent_runner is None:
                    raise RuntimeError('native agent acceptance requires its project sandbox helper')
                command += [str(args.agent_binary), str(args.agent_runner)]
            if (args.hosted_worker or args.agent_binary is not None) and args.cases:
                command.append(args.cases)
            child = subprocess.run(command,
                                   env=env, cwd=args.repository, timeout=600)
            if child.returncode != 0:
                raise RuntimeError('hosted worker or native agent acceptance failed')
            summary = json.loads((api/'summary.json').read_text())
            private_json(args.output/'summary.json', summary)
            return
    log = (api/'server.log').open('wb')
    server = subprocess.Popen([bun, str(args.repository/'backend/tests/compat/tfpolicy-owner/entitlement-server.ts'), str(api)],
                              env=env, cwd=args.repository, stdout=log, stderr=subprocess.STDOUT)
    try:
        until = time.monotonic()+30
        while not (api/'context.json').exists() and time.monotonic()<until:
            if server.poll() is not None:
                raise RuntimeError('isolated Terrence API failed; inspect its private server log')
            time.sleep(.05)
        context = json.loads((api/'context.json').read_text())
        request = urllib.request.Request('https://'+context['runContext']['host']+'/api/v2/organizations/'+context['runContext']['organization']+'/entitlement-set',
                                         headers={'Authorization': 'Bearer '+context['runContext']['token']})
        with urllib.request.urlopen(request, context=ssl.create_default_context(cafile=str(api/'server.crt')), timeout=5) as response:
            entitlement = json.load(response)
        if entitlement['data']['attributes']['tf-policy-enforcement'] is not True:
            raise RuntimeError('canonical API did not advertise its genuine native policy capability')
        rows = matrix(args, runtime, context)
        private_json(args.output/'summary.json', {'realPluginCases': rows, 'productionAdmission': False})
        print(json.dumps({'realPluginCasesPassed': len(rows), 'productionAdmission': False}))
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
        log.close()
        (api/'context.json').unlink(missing_ok=True)
        stopped = json.loads((api/'stopped.json').read_text()) if (api/'stopped.json').exists() else {}
        if not stopped.get('tokenRevoked') or not stopped.get('serverStopped'):
            raise RuntimeError('API shutdown/token revocation was not verified')


if __name__ == '__main__':
    os.umask(0o077)
    main()
