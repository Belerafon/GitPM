#!/usr/bin/env python3
"""Mutation tests proving the planning validator rejects structural and architectural regressions."""
from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Callable
import yaml

SOURCE_ROOT = Path(__file__).resolve().parents[1]
TRACE_REL = Path('docs/GitPM_Requirements_Traceability_v0.5.yaml')
IMPL_REL = Path('docs/GitPM_Implementation_Plan_v0.7.md')
WORK_REL = Path('docs/GitPM_Work_Plan_v0.6.md')
STATUS_REL = Path('docs/GitPM_Execution_Status_v0.1.yaml')
VALIDATOR_REL = Path('scripts/validate_planning.py')

def copy_repo(target: Path) -> None:
    shutil.copytree(SOURCE_ROOT,target,ignore=shutil.ignore_patterns('.git','__pycache__','*.pyc','*.zip'),dirs_exist_ok=True)

def run_validator(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(['python3',str(root/VALIDATOR_REL)],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,check=False)

def load(root:Path,rel:Path)->dict:
    return yaml.safe_load((root/rel).read_text(encoding='utf-8'))

def save(root:Path,rel:Path,data:dict)->None:
    (root/rel).write_text(yaml.safe_dump(data,allow_unicode=True,sort_keys=False,width=120),encoding='utf-8')

def duplicate_stage(root:Path):
    d=load(root,TRACE_REL); d['stages'].append(dict(d['stages'][0])); save(root,TRACE_REL,d)

def dependency_cycle(root:Path):
    d=load(root,TRACE_REL); d['stages'][0]['dependencies']=['P14']; save(root,TRACE_REL,d)

def wrong_check_sequence(root:Path):
    d=load(root,TRACE_REL); d['verification_checks'][0]['id']='VFY-999'; save(root,TRACE_REL,d)

def empty_acceptance(root:Path):
    d=load(root,TRACE_REL); d['requirements'][0]['acceptance_criteria']=[]; save(root,TRACE_REL,d)

def inexact_gate(root:Path):
    d=load(root,TRACE_REL); d['release_gates']['alpha']['required_checks']=d['release_gates']['alpha']['required_checks'][:-1]; save(root,TRACE_REL,d)

def duplicate_yaml_key(root:Path):
    p=root/TRACE_REL; p.write_text(p.read_text(encoding='utf-8')+'\nversion: duplicate\n',encoding='utf-8')

def reintroduce_rebase(root:Path):
    p=root/IMPL_REL; p.write_text(p.read_text(encoding='utf-8')+'\nPOST /api/drafts/:id/rebase\n',encoding='utf-8')

def live_gitlab_env(root:Path):
    d=load(root,TRACE_REL); d['verification_checks'][0]['environment']='real-gitlab'; save(root,TRACE_REL,d)

def missing_source_heading(root:Path):
    d=load(root,TRACE_REL); d['requirements'][0]['source']['section']='999. Missing'; save(root,TRACE_REL,d)

def work_metadata_mismatch(root:Path):
    p=root/WORK_REL; txt=p.read_text(encoding='utf-8').replace('- Size: `M`','- Size: `L`',1); p.write_text(txt,encoding='utf-8')

def done_without_evidence(root:Path):
    d=load(root,STATUS_REL); d['stages']['P00']['status']='done'; d['stages']['P00']['accepted_by']=[]; d['stages']['P00']['evidence']=[]; save(root,STATUS_REL,d)

def reintroduce_webhook(root:Path):
    p=root/IMPL_REL; p.write_text(p.read_text(encoding='utf-8')+'\nwebhook handler\n',encoding='utf-8')

def remove_mandatory_russian(root:Path):
    p=root/IMPL_REL
    txt=p.read_text(encoding='utf-8').replace('русский `ru` является обязательным','русский `ru` доступен',1)
    p.write_text(txt,encoding='utf-8')

def late_mandatory_check(root:Path):
    d=load(root,TRACE_REL); d['verification_checks'][2]['mandatory_from']='release'; save(root,TRACE_REL,d)

MUTATIONS:list[tuple[str,Callable[[Path],None]]]=[
 ('duplicate stage ID',duplicate_stage),('dependency cycle',dependency_cycle),('wrong verification sequence',wrong_check_sequence),
 ('empty requirement acceptance',empty_acceptance),('inexact release gate',inexact_gate),('duplicate YAML key',duplicate_yaml_key),
 ('reintroduced rebase API',reintroduce_rebase),('live GitLab environment',live_gitlab_env),('missing source heading',missing_source_heading),
 ('work plan metadata mismatch',work_metadata_mismatch),('done stage without evidence',done_without_evidence),('reintroduced webhook',reintroduce_webhook),
 ('check mandatory later than owning stage',late_mandatory_check),('mandatory Russian removed',remove_mandatory_russian),
]

def main()->int:
    with tempfile.TemporaryDirectory(prefix='gitpm-planning-selftest-') as temp:
        baseline=Path(temp)/'baseline'; copy_repo(baseline)
        result=run_validator(baseline)
        if result.returncode!=0:
            print('Baseline validation unexpectedly failed:'); print(result.stdout); return 1
        for i,(name,mutate) in enumerate(MUTATIONS,1):
            case=Path(temp)/f'case-{i}'; copy_repo(case); mutate(case); result=run_validator(case)
            if result.returncode==0:
                print(f'Mutation was not detected: {name}'); print(result.stdout); return 1
            print(f'PASS: validator rejected {name}')
    print(f'Planning validator self-test passed: {len(MUTATIONS)} mutations rejected')
    return 0
if __name__=='__main__': raise SystemExit(main())
