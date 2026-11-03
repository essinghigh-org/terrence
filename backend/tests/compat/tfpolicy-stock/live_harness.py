#!/usr/bin/env python3
"""CI-only research live go-plugin test. Never touches cloud infrastructure.
Expected invocation: python live_harness.py /verified/terraform /built/tfpolicy-harness
The one-resource inventory is a FIXTURE ORACLE, not production derivation.
"""
import hashlib,json,os,pathlib,signal,subprocess,sys,tempfile

def sha(data):return hashlib.sha256(data).hexdigest()
def run(argv,cwd,env):
    # Own the whole test process group, including nested mock/recorder plugins.
    process=subprocess.Popen(argv,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    try:
        stdout,stderr=process.communicate(timeout=90)
        return subprocess.CompletedProcess(argv,process.returncode,stdout,stderr)
    finally:
        try: os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        process.communicate()
def admitted(process,events,journal,plan):
    if process.returncode not in (0,2) or not plan or not process.stdout.endswith(b'\n'):return False
    if any(e.get('type') in ('diagnostic','policy_diagnostic') and e.get(e['type'],{}).get('severity')!='warning' for e in events):return False
    if not journal or any(not e['Finished'] or e['Failed'] for e in journal):return False
    setup=[e for e in journal if e['Method']=='Setup']
    resource=[e for e in journal if e['Method']=='EvaluateResource']
    # Mock verifies exact fixture resource metadata/input and calls native GetResources.
    callbacks=[e for e in journal if e['Method']=='GetResources']
    providers=[e for e in journal if e['Method']=='EvaluateProvider']
    return len(setup)==1 and len(resource)==1 and len(callbacks)==1 and len(providers)==1 and len(journal)==4 and resource[0]['Result']==3 and providers[0]['Result']==3

def authorize(receipt,plan,scope):return receipt=={'plan':sha(plan),'scope':scope}

def main():
    terraform,harness=map(lambda s:str(pathlib.Path(s).resolve()),sys.argv[1:])
    base_env=dict(os.environ,TF_IN_AUTOMATION='1',CHECKPOINT_DISABLE='1')
    version=subprocess.run([terraform,'version','-json'],env=base_env,capture_output=True,check=True,timeout=15)
    assert json.loads(version.stdout)['terraform_version']=='1.17.1'
    report=[]
    with tempfile.TemporaryDirectory(prefix='stock-tfpolicy-ci-') as root:
      for mode in ('missing','setup-error','incomplete','evaluation-crash','deny','allow'):
        folder=pathlib.Path(root,mode);folder.mkdir();(folder/'policies').mkdir()
        (folder/'main.tf').write_text('resource "terraform_data" "canary" { input = "test-only" }\n')
        (folder/'policies'/'fixture.policy.hcl').write_text('# Policy semantics are supplied by the mock runtime.\n')
        journal_path=folder/'journal.json'
        env=dict(base_env,TF_POLICY_PLUGIN=harness if mode!='missing' else str(folder/'missing'),TFPOLICY_TEST_MODE=mode,TFPOLICY_JOURNAL=str(journal_path))
        init=run([terraform,'init','-input=false','-no-color'],folder,env)
        assert init.returncode==0,init.stderr.decode()
        result=run([terraform,'plan','-json','-input=false','-policies='+str(folder/'policies'),'-out=saved.tfplan'],folder,env)
        events=[json.loads(line) for line in result.stdout.splitlines()]
        journal=json.loads(journal_path.read_text()) if journal_path.exists() else []
        plan=(folder/'saved.tfplan').read_bytes() if (folder/'saved.tfplan').exists() else b''
        allow=admitted(result,events,journal,plan)
        assert allow==(mode=='allow'),(mode,result.returncode,journal,result.stdout.decode(),result.stderr.decode())
        assert not (folder/'terraform.tfstate').exists(), 'plan mutated persistent state'
        if allow:
          receipt={'plan':sha(plan),'scope':'scope1'}
          def apply_if_admitted(scope):
            # Re-read the actual saved-plan file at this fixture's apply boundary.
            # Production still needs locking/fencing, not only this hash check.
            if not authorize(receipt,(folder/'saved.tfplan').read_bytes(),scope):
              return None
            return run([terraform,'apply','-input=false','-auto-approve','saved.tfplan'],folder,env)
          (folder/'saved.tfplan').write_bytes(plan+b'tamper')
          assert apply_if_admitted('scope1') is None
          assert not (folder/'terraform.tfstate').exists()
          (folder/'saved.tfplan').write_bytes(plan)
          assert apply_if_admitted('scope2') is None
          assert not (folder/'terraform.tfstate').exists()
          # Its sole effect is local terraform_data state. No cloud creds used.
          apply=apply_if_admitted('scope1')
          assert apply is not None and apply.returncode==0, apply.stderr.decode() if apply else 'not admitted'
          assert (folder/'terraform.tfstate').exists()
        report.append({'stage':'plan','mode':mode,'terraform_exit':result.returncode,'admitted':allow,'rpc_events':len(journal)})
      # Native apply policies run after managed-resource processing. Establish
      # truthful failed/incomplete policy outcomes without throwing away state.
      for mode in ('missing','setup-error','incomplete','evaluation-crash','deny','allow'):
        folder=pathlib.Path(root,'apply-'+mode);folder.mkdir();(folder/'policies').mkdir()
        (folder/'main.tf').write_text('resource "terraform_data" "canary" { input = "test-only" }\n')
        (folder/'policies'/'fixture.policy.hcl').write_text('# Mock runtime fixture.\n')
        policy_flag='-policies='+str(folder/'policies')
        plan_env=dict(base_env,TF_POLICY_PLUGIN=harness,TFPOLICY_TEST_MODE='allow',TFPOLICY_JOURNAL=str(folder/'plan-journal.json'))
        initialized=run([terraform,'init','-input=false','-no-color'],folder,plan_env)
        assert initialized.returncode==0,initialized.stderr.decode()
        planned=run([terraform,'plan','-json','-input=false',policy_flag,'-out=saved.tfplan'],folder,plan_env)
        saved=(folder/'saved.tfplan').read_bytes()
        assert admitted(planned,[json.loads(x) for x in planned.stdout.splitlines()],json.loads((folder/'plan-journal.json').read_text()),saved)
        receipt={'plan':sha(saved),'scope':'scope1'}
        assert authorize(receipt,(folder/'saved.tfplan').read_bytes(),'scope1')
        apply_journal=folder/'apply-journal.json'
        apply_env=dict(base_env,TF_POLICY_PLUGIN=harness if mode!='missing' else str(folder/'missing'),TFPOLICY_TEST_MODE=mode,TFPOLICY_JOURNAL=str(apply_journal))
        applied=run([terraform,'apply','-json','-input=false','-auto-approve',policy_flag,'saved.tfplan'],folder,apply_env)
        events=[json.loads(line) for line in applied.stdout.splitlines()]
        journal=json.loads(apply_journal.read_text()) if apply_journal.exists() else []
        compliant=admitted(applied,events,journal,saved)
        assert compliant==(mode=='allow'),(mode,applied.returncode,journal,applied.stdout.decode(),applied.stderr.decode())
        state_path=folder/'terraform.tfstate'
        assert state_path.exists(),(mode,'post-apply state was not retained',applied.stderr.decode())
        resulting_state=json.loads(state_path.read_text())
        resources=resulting_state.get('resources',[])
        assert any(r.get('type')=='terraform_data' and r.get('name')=='canary' and r.get('instances') for r in resources),(mode,resulting_state)
        # A failed policy result is not a failed-to-mutate or rolled-back apply.
        report.append({'stage':'apply','mode':mode,'terraform_exit':applied.returncode,'compliant':compliant,'state_retained':True,'infrastructure_changed':True,'rpc_events':len(journal)})
    print(json.dumps({'terraform':'1.17.1','results':report,'warning':'fixture inventory only; not production admission'},indent=2))

if __name__=='__main__':main()
