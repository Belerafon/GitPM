#!/usr/bin/env python3
"""Self-test for factual release-gate status and evidence validation."""
from __future__ import annotations
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import yaml

SOURCE=Path(__file__).resolve().parents[1]

def run(root:Path)->subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable,'scripts/check_release_gate.py','--gate','alpha'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,check=False)

def main()->int:
    with tempfile.TemporaryDirectory(prefix='gitpm-gate-selftest-') as td:
        root=Path(td)/'repo'
        shutil.copytree(
            SOURCE,
            root,
            ignore=shutil.ignore_patterns(
                '.git', 'node_modules', 'dist', 'coverage', '.pnpm-store',
                '__pycache__', '*.pyc', '*.zip', '*.tsbuildinfo',
            ),
        )
        baseline=run(root)
        if baseline.returncode==0:
            print('Pending baseline gate unexpectedly passed'); print(baseline.stdout); return 1
        trace=yaml.safe_load((root/'docs/GitPM_Requirements_Traceability_v0.5.yaml').read_text(encoding='utf-8'))
        status_path=root/'docs/GitPM_Execution_Status_v0.1.yaml'
        status=yaml.safe_load(status_path.read_text(encoding='utf-8'))
        evidence=root/'evidence/selftest/pass.txt'; evidence.parent.mkdir(parents=True); evidence.write_text('self-test evidence\n',encoding='utf-8')
        ref='file:evidence/selftest/pass.txt'
        gate=trace['release_gates']['alpha']
        stages={stage['id']:stage for stage in trace['stages']}
        for sid in gate['required_stages']:
            status['stages'][sid].update(status='done',accepted_by=stages[sid]['acceptance'][:1],evidence=[ref])
        for cid in gate['required_checks']:
            status['verification_checks'][cid].update(status='passed',evidence=[ref])
        status_path.write_text(yaml.safe_dump(status,allow_unicode=True,sort_keys=False,width=120),encoding='utf-8')
        passed=run(root)
        if passed.returncode!=0:
            print('Complete gate unexpectedly failed'); print(passed.stdout); return 1
        status=yaml.safe_load(status_path.read_text(encoding='utf-8'))
        status['verification_checks'][gate['required_checks'][0]]['evidence']=['file:evidence/missing.txt']
        status_path.write_text(yaml.safe_dump(status,allow_unicode=True,sort_keys=False,width=120),encoding='utf-8')
        missing=run(root)
        if missing.returncode==0:
            print('Gate with missing evidence unexpectedly passed'); print(missing.stdout); return 1
    print('Release gate self-test passed: pending rejected, complete passed, missing evidence rejected')
    return 0
if __name__=='__main__': raise SystemExit(main())
