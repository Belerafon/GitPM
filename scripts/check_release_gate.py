#!/usr/bin/env python3
"""Check factual completion of a GitPM release gate from execution status and evidence."""
from __future__ import annotations
import argparse
from pathlib import Path
import sys
import yaml

ROOT=Path(__file__).resolve().parents[1]
DOCS=ROOT/'docs'
TRACE=DOCS/'GitPM_Requirements_Traceability_v0.4.yaml'
STATUS=DOCS/'GitPM_Execution_Status_v0.1.yaml'

def load(path:Path):
    return yaml.safe_load(path.read_text(encoding='utf-8'))

def evidence_error(ref: object) -> str | None:
    if not isinstance(ref,str) or ':' not in ref:
        return 'must use file:, url:, ci: or sha: prefix'
    kind,value=ref.split(':',1)
    if kind not in {'file','url','ci','sha'} or not value.strip():
        return 'must use non-empty file:, url:, ci: or sha: reference'
    if kind=='file':
        candidate=(ROOT/value).resolve()
        try:
            candidate.relative_to(ROOT.resolve())
        except ValueError:
            return 'file evidence escapes repository root'
        if not candidate.exists():
            return f'file evidence does not exist: {value}'
    return None

def main()->int:
    p=argparse.ArgumentParser()
    p.add_argument('--gate',choices=['alpha','beta','release_candidate','release'],required=True)
    args=p.parse_args()
    reg=load(TRACE); status=load(STATUS); gate=reg['release_gates'][args.gate]
    unmet=[]
    for sid in gate['required_stages']:
        item=status['stages'][sid]
        if item.get('status')!='done':
            unmet.append(f"stage {sid}: status={item.get('status')}")
            continue
        if not item.get('accepted_by'): unmet.append(f"stage {sid}: accepted_by missing")
        if not item.get('evidence'): unmet.append(f"stage {sid}: evidence missing")
        for ref in item.get('evidence',[]):
            err=evidence_error(ref)
            if err: unmet.append(f"stage {sid}: {err}")
    for cid in gate['required_checks']:
        item=status['verification_checks'][cid]
        if item.get('status')!='passed':
            unmet.append(f"check {cid}: status={item.get('status')}")
            continue
        if not item.get('evidence'): unmet.append(f"check {cid}: evidence missing")
        for ref in item.get('evidence',[]):
            err=evidence_error(ref)
            if err: unmet.append(f"check {cid}: {err}")
    if unmet:
        print(f"Gate {args.gate} NOT READY: {len(unmet)} unmet conditions")
        for line in unmet: print(f"- {line}")
        return 1
    print(f"Gate {args.gate} PASSED: {len(gate['required_stages'])} stages and {len(gate['required_checks'])} checks")
    return 0
if __name__=='__main__': raise SystemExit(main())
