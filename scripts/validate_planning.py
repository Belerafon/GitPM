#!/usr/bin/env python3
"""Validate GitPM planning document references and traceability coverage."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
WORK = DOCS / "GitPM_Work_Plan_v0.2.md"
IMPL = DOCS / "GitPM_Implementation_Plan_v0.3.md"
TRACE = DOCS / "GitPM_Requirements_Traceability_v0.1.yaml"
PROGRESS = DOCS / "PROGRESS.md"

errors: list[str] = []
for path in (WORK, IMPL, TRACE, PROGRESS):
    if not path.is_file():
        errors.append(f"missing required file: {path.relative_to(ROOT)}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)

work = WORK.read_text(encoding="utf-8")
impl = IMPL.read_text(encoding="utf-8")
trace = TRACE.read_text(encoding="utf-8")
progress = PROGRESS.read_text(encoding="utf-8")

stage_ids = set(re.findall(r"^## (P(?:00S|\d{2}[A-C]?))\.", work, flags=re.M))
e2e_ids = set(re.findall(r"E2E-\d{3}", work))

if len(stage_ids) != 18:
    errors.append(f"expected 18 unique stages, got {len(stage_ids)}: {sorted(stage_ids)}")
if len(e2e_ids) != 45:
    errors.append(f"expected 45 E2E IDs, got {len(e2e_ids)}")

req_ids = re.findall(r"^  - id: ([A-Z0-9-]+)$", trace, flags=re.M)
if not req_ids:
    errors.append("traceability registry has no requirements")
if len(req_ids) != len(set(req_ids)):
    errors.append("duplicate requirement IDs")

for stage in re.findall(r"^    stage: (P\S+)$", trace, flags=re.M):
    if stage not in stage_ids:
        errors.append(f"traceability references unknown stage: {stage}")

for test in re.findall(r"E2E-\d{3}", trace):
    if test not in e2e_ids:
        errors.append(f"traceability references unknown test: {test}")

# Every E2E must be covered by at least one requirement.
trace_tests = set(re.findall(r"E2E-\d{3}", trace))
missing_tests = sorted(e2e_ids - trace_tests)
if missing_tests:
    errors.append(f"E2E IDs missing from traceability: {', '.join(missing_tests)}")

# Prevent active-document ambiguity.
for obsolete in ("GitPM_Work_Plan_v0.1.md", "GitPM_Implementation_Plan_v0.2.md"):
    if (DOCS / obsolete).exists():
        errors.append(f"obsolete active plan still present: docs/{obsolete}")

if "## 21. План реализации по этапам" in impl:
    errors.append("implementation plan still contains duplicate executable stage plan")

for ref in ("GitPM_Work_Plan_v0.2.md", "GitPM_Implementation_Plan_v0.3.md"):
    if ref not in progress:
        errors.append(f"PROGRESS.md does not reference {ref}")

if errors:
    print("Planning validation failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)

print(f"Planning validation passed: {len(stage_ids)} stages, {len(e2e_ids)} E2E tests, {len(req_ids)} requirements")
