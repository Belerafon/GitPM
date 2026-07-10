#!/usr/bin/env python3
"""Small helper for changing stage/check status without editing YAML structure manually."""
from __future__ import annotations
import argparse
from datetime import date
from pathlib import Path
import yaml

ROOT=Path(__file__).resolve().parents[1]
PATH=ROOT/'docs/GitPM_Execution_Status_v0.1.yaml'

def main()->int:
    p=argparse.ArgumentParser()
    p.add_argument('kind',choices=['stage','check'])
    p.add_argument('id')
    p.add_argument('status')
    p.add_argument('--evidence',action='append',default=[])
    p.add_argument('--accepted-by',action='append',default=[])
    p.add_argument('--notes',default=None)
    args=p.parse_args()
    data=yaml.safe_load(PATH.read_text(encoding='utf-8'))
    key='stages' if args.kind=='stage' else 'verification_checks'
    if args.id not in data[key]: raise SystemExit(f"unknown {args.kind}: {args.id}")
    item=data[key][args.id]; item['status']=args.status
    if args.evidence: item['evidence']=args.evidence
    if args.kind=='stage' and args.accepted_by: item['accepted_by']=args.accepted_by
    if args.notes is not None: item['notes']=args.notes
    data['updated_at']=date.today().isoformat()
    PATH.write_text(yaml.safe_dump(data,allow_unicode=True,sort_keys=False,width=120),encoding='utf-8')
    return 0
if __name__=='__main__': raise SystemExit(main())
