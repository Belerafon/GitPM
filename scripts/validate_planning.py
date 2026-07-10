#!/usr/bin/env python3
"""Validate consistency of GitPM planning documents, DAG, traceability and execution-state shape."""
from __future__ import annotations

from collections import Counter, defaultdict, deque
from pathlib import Path
import re
import sys
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
EXPECTED = {
    "implementation_plan": "GitPM_Implementation_Plan_v0.7.md",
    "work_plan": "GitPM_Work_Plan_v0.7.md",
    "delivery_policies": "GitPM_Delivery_Policies_v0.5.md",
    "security_baseline": "GitPM_Security_Baseline_v0.5.md",
    "maintenance_guide": "GitPM_Planning_Maintenance_Guide_v0.3.md",
    "execution_status": "GitPM_Execution_Status_v0.1.yaml",
    "progress": "PROGRESS.md",
}
TRACE_NAME = "GitPM_Requirements_Traceability_v0.5.yaml"
ALLOWED_ACTIVE_PATTERNS = {
    "GitPM_Implementation_Plan_v*.md": EXPECTED["implementation_plan"],
    "GitPM_Work_Plan_v*.md": EXPECTED["work_plan"],
    "GitPM_Requirements_Traceability_v*.yaml": TRACE_NAME,
    "GitPM_Delivery_Policies_v*.md": EXPECTED["delivery_policies"],
    "GitPM_Security_Baseline_v*.md": EXPECTED["security_baseline"],
    "GitPM_Planning_Maintenance_Guide_v*.md": EXPECTED["maintenance_guide"],
}

errors: list[str] = []

def fail(message: str) -> None:
    errors.append(message)

class UniqueKeyLoader(yaml.SafeLoader):
    pass

def construct_mapping(loader: UniqueKeyLoader, node: yaml.nodes.MappingNode, deep: bool = False) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError("while constructing a mapping", node.start_mark, f"duplicate key: {key}", key_node.start_mark)
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping

UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)

def load_yaml(path: Path) -> Any:
    try:
        return yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    except Exception as exc:
        fail(f"cannot parse YAML {path.name}: {exc}")
        return {}

def read(name: str) -> str:
    path = DOCS / name
    if not path.exists():
        fail(f"missing document: {name}")
        return ""
    return path.read_text(encoding="utf-8")

# Active-version hygiene.
for pattern, expected in ALLOWED_ACTIVE_PATTERNS.items():
    names = sorted(p.name for p in DOCS.glob(pattern))
    if names != [expected]:
        fail(f"active files for {pattern} must be exactly [{expected}], got {names}")

impl = read(EXPECTED["implementation_plan"])
work = read(EXPECTED["work_plan"])
delivery = read(EXPECTED["delivery_policies"])
security = read(EXPECTED["security_baseline"])
maintenance = read(EXPECTED["maintenance_guide"])
progress = read(EXPECTED["progress"])
registry = load_yaml(DOCS / TRACE_NAME)
execution = load_yaml(DOCS / EXPECTED["execution_status"])

if registry.get("version") != "0.5":
    fail("traceability version must be 0.5")
if registry.get("documents") != EXPECTED:
    fail(f"registry documents mismatch: expected {EXPECTED}, got {registry.get('documents')}")

# Active normative documents may not point to superseded active-version filenames.
active_text = "\n".join([impl, work, delivery, security, maintenance, progress, (ROOT / "README.md").read_text(encoding="utf-8")])
for pattern, expected_name in ALLOWED_ACTIVE_PATTERNS.items():
    prefix, suffix = pattern.split("*")
    for match in re.findall(re.escape(prefix) + r"[^`\s]+" + re.escape(suffix), active_text):
        if match != expected_name:
            fail(f"stale normative document reference found: {match}; expected {expected_name}")

# Normative architectural decisions that must remain unambiguous.
required_phrases = {
    "implementation": [
        "для Project ID равен имени каталога",
        "P01 завершается не schema drafts",
        "Перед каждым созданием draft server под repository-wide lock выполняет fetch",
        "одновременно разрешен ровно один writer mode",
        "OAuth 2.0 Authorization Code Flow with PKCE",
        "Webhook отсутствует в v0.1",
        "Commit в v0.1 всегда включает все изменения draft",
        "Gantt только читает",
        "русский `ru` является обязательным",
        "API возвращает стабильный error code",
    ],
    "delivery": ["one writer mode", "commit always includes all draft changes", "Webhook is absent", "Russian `ru` is mandatory"],
    "work": [
        "не реже чем после каждого завершенного work package",
        "Stage evidence содержит commit SHA или диапазон commit series",
    ],
    "maintenance": ["Gate checker confirms actual execution" if False else "Gate checker"],
}
for phrase in required_phrases["implementation"]:
    if phrase not in impl:
        fail(f"implementation missing required decision: {phrase}")
for phrase in required_phrases["delivery"]:
    if phrase not in delivery:
        fail(f"delivery policy missing required decision: {phrase}")
for phrase in required_phrases["work"]:
    if phrase not in work:
        fail(f"work plan missing required commit cadence: {phrase}")
if "Gate checker" not in maintenance and "gate checker" not in maintenance:
    fail("maintenance guide must explain gate checker")

for forbidden in [
    "/rebase", "restore/lines", "SSE or polling", "optional swimlane", "mandatory live GitLab",
    "webhook handler", "GitLab -> webhook", "planning_ready",
]:
    combined = "\n".join([impl, work, delivery, security, maintenance, progress])
    if forbidden.lower() in combined.lower():
        fail(f"forbidden obsolete decision found: {forbidden}")
if re.search(r"\bE2E-\d{3}\b", "\n".join([impl, work, delivery, security, maintenance, progress])):
    fail("obsolete E2E IDs found in active Markdown documents")

stages = registry.get("stages", [])
requirements = registry.get("requirements", [])
checks = registry.get("verification_checks", [])
gates = registry.get("release_gates", {})
for label, value in (("stages", stages), ("requirements", requirements), ("verification_checks", checks)):
    if not isinstance(value, list) or not value:
        fail(f"registry {label} must be a non-empty list")
        value = []

def collect_ids(items: list[Any], label: str) -> list[str]:
    ids: list[str] = []
    raw: list[Any] = []
    for item in items:
        if not isinstance(item, dict):
            fail(f"{label} entry must be a mapping")
            continue
        item_id = item.get("id")
        raw.append(item_id)
        if isinstance(item_id, str) and item_id:
            ids.append(item_id)
        else:
            fail(f"{label} contains missing/invalid id")
    duplicates = sorted(key for key, count in Counter(raw).items() if key is not None and count > 1)
    if duplicates:
        fail(f"duplicate {label} IDs: {duplicates}")
    return ids

stage_ids = collect_ids(stages, "stage")
req_ids = collect_ids(requirements, "requirement")
check_ids = collect_ids(checks, "verification check")
stage_set, req_set, check_set = set(stage_ids), set(req_ids), set(check_ids)
expected_checks = [f"VFY-{i:03d}" for i in range(1, len(check_ids) + 1)]
if check_ids != expected_checks:
    fail(f"verification check IDs must be contiguous and ordered: {expected_checks[:1]}..{expected_checks[-1:]}")

# Stage schema and DAG.
size_weight = {"S": 1, "M": 2, "L": 3}
stage_by_id: dict[str, dict[str, Any]] = {}
adjacency: dict[str, list[str]] = defaultdict(list)
indegree = {sid: 0 for sid in stage_ids}
for stage in stages:
    if not isinstance(stage, dict) or not isinstance(stage.get("id"), str):
        continue
    sid = stage["id"]
    stage_by_id[sid] = stage
    for field in ("title","size","estimate","dependencies","accountable","responsible","acceptance","milestone"):
        if field not in stage:
            fail(f"stage {sid} missing field {field}")
    if stage.get("size") not in size_weight:
        fail(f"stage {sid} size must be S/M/L")
    if not re.fullmatch(r"\d+-\d+", str(stage.get("estimate",""))):
        fail(f"stage {sid} estimate must be N-N")
    if not isinstance(stage.get("accountable"), str) or not stage.get("accountable"):
        fail(f"stage {sid} must have exactly one accountable")
    for field in ("responsible","acceptance"):
        if not isinstance(stage.get(field), list) or not stage.get(field):
            fail(f"stage {sid} {field} must be non-empty list")
    deps = stage.get("dependencies")
    if not isinstance(deps, list):
        fail(f"stage {sid} dependencies must be list")
        continue
    if len(deps) != len(set(deps)):
        fail(f"stage {sid} has duplicate dependencies")
    for dep in deps:
        if dep == sid:
            fail(f"stage {sid} depends on itself")
        elif dep not in stage_set:
            fail(f"stage {sid} references unknown dependency {dep}")
        else:
            adjacency[dep].append(sid)
            indegree[sid] += 1

queue = deque(sorted(s for s,d in indegree.items() if d == 0))
topological: list[str] = []
while queue:
    cur = queue.popleft(); topological.append(cur)
    for nxt in sorted(adjacency[cur]):
        indegree[nxt] -= 1
        if indegree[nxt] == 0:
            queue.append(nxt)
if len(topological) != len(stage_ids):
    fail(f"stage DAG contains cycle: {sorted(k for k,v in indegree.items() if v>0)}")

# Qualitative critical path.
score: dict[str,int] = {}; pred: dict[str,str|None] = {}
for sid in topological:
    deps = stage_by_id[sid].get("dependencies", [])
    weight = size_weight.get(stage_by_id[sid].get("size"), 0)
    if not deps: score[sid], pred[sid] = weight, None
    else:
        best=max(deps,key=lambda d: score.get(d,-1)); score[sid]=score[best]+weight; pred[sid]=best
critical=[]
if score:
    node=max(score,key=score.get)
    while node:
        critical.append(node); node=pred[node]
    critical.reverse()

# Work Plan headings, sections and metadata must match registry exactly.
markdown_stage_ids = re.findall(r"^## (P[0-9A-Z]+)\.", work, flags=re.M)
if markdown_stage_ids != stage_ids:
    fail("work plan stage heading order/set must exactly match registry")
for section in ("### Objective","### Entry criteria","### Work packages","### Artifacts","### Automated verification","### Manual acceptance","### Owned verification checks","### Exit gate"):
    if work.count(section) != len(stage_ids):
        fail(f"work plan section count mismatch for {section}")
if "Параллельность:" in work:
    fail("manual parallelism field is prohibited")

for i,sid in enumerate(stage_ids):
    start = work.index(f"## {sid}. ")
    end = work.index(f"## {stage_ids[i+1]}. ") if i+1 < len(stage_ids) else len(work)
    block = work[start:end]
    stage = stage_by_id[sid]
    expected_lines = {
        "Size": stage["size"],
        "Estimate": f"{stage['estimate']} engineer-days",
        "Dependencies": ", ".join(stage["dependencies"]) if stage["dependencies"] else "none",
        "Accountable": stage["accountable"],
        "Responsible": ", ".join(stage["responsible"]),
        "Acceptance": ", ".join(stage["acceptance"]),
        "Milestone": stage["milestone"],
    }
    for label,value in expected_lines.items():
        if f"- {label}: `{value}`" not in block:
            fail(f"work plan metadata mismatch for {sid} {label}: expected {value}")

# Exact implementation headings for trace sources.
headings = set(re.findall(r"^##+\s+(.+?)\s*$", impl, flags=re.M))
req_by_id: dict[str,dict[str,Any]] = {}
for req in requirements:
    if not isinstance(req, dict) or not isinstance(req.get("id"), str): continue
    rid=req["id"]; req_by_id[rid]=req
    for field in ("description","source","owner","stage","release_gate","acceptance_criteria","checks"):
        if field not in req: fail(f"requirement {rid} missing {field}")
    if req.get("stage") not in stage_set: fail(f"requirement {rid} unknown stage")
    if req.get("release_gate") not in {"alpha","beta","release"}: fail(f"requirement {rid} invalid release_gate")
    if not isinstance(req.get("acceptance_criteria"),list) or not req.get("acceptance_criteria"): fail(f"requirement {rid} acceptance_criteria must be non-empty")
    if not isinstance(req.get("checks"),list) or not req.get("checks"): fail(f"requirement {rid} checks must be non-empty")
    source=req.get("source")
    if not isinstance(source,dict) or source.get("document") != EXPECTED["implementation_plan"]:
        fail(f"requirement {rid} source document mismatch")
    elif source.get("section") not in headings:
        fail(f"requirement {rid} source.section does not exist exactly: {source.get('section')}")
    for cid in req.get("checks",[]):
        if cid not in check_set: fail(f"requirement {rid} references unknown check {cid}")

# Verification checks and milestone consistency.
valid_types={"smoke","planning","unit","integration","fault","security","browser","agent","performance","acceptance"}
valid_envs={"ci-clean-linux","integration-local","fault-local","security-local","browser-local","agent-local","perf-local"}
check_by_id: dict[str,dict[str,Any]]={}
stage_milestone_rank={"foundation":0,"alpha":0,"beta":1,"release_candidate":2,"release":2}
mandatory_rank={"alpha":0,"beta":1,"release":2}
for check in checks:
    if not isinstance(check,dict) or not isinstance(check.get("id"),str): continue
    cid=check["id"]; check_by_id[cid]=check
    for field in ("title","stage","mandatory_from","test_type","environment","actor","preconditions","steps","expected_result","evidence","requirements"):
        if field not in check: fail(f"{cid} missing field {field}")
    if check.get("stage") not in stage_set: fail(f"{cid} unknown stage")
    if check.get("mandatory_from") not in mandatory_rank: fail(f"{cid} invalid mandatory_from")
    if check.get("test_type") not in valid_types: fail(f"{cid} invalid test_type")
    if check.get("environment") not in valid_envs: fail(f"{cid} invalid environment")
    for field in ("preconditions","steps","expected_result","evidence","requirements"):
        if not isinstance(check.get(field),list) or not check.get(field): fail(f"{cid} {field} must be non-empty list")
    if check.get("stage") in stage_by_id and check.get("mandatory_from") in mandatory_rank:
        if mandatory_rank[check["mandatory_from"]] > stage_milestone_rank[stage_by_id[check["stage"]]["milestone"]]:
            fail(f"{cid} becomes mandatory later than its owning stage can close")
    for rid in check.get("requirements",[]):
        if rid not in req_set: fail(f"{cid} references unknown requirement {rid}")
        elif cid not in req_by_id[rid].get("checks",[]): fail(f"bidirectional link missing: {cid} -> {rid}")
for rid,req in req_by_id.items():
    for cid in req.get("checks",[]):
        if rid not in check_by_id.get(cid,{}).get("requirements",[]): fail(f"bidirectional link missing: {rid} -> {cid}")

# Owned checks must appear in work plan stage.
for i,sid in enumerate(stage_ids):
    start=work.index(f"## {sid}. "); end=work.index(f"## {stage_ids[i+1]}. ") if i+1<len(stage_ids) else len(work)
    block=work[start:end]
    owned=[c["id"] for c in checks if c.get("stage")==sid]
    if owned:
        for cid in owned:
            if f"`{cid}`" not in block: fail(f"work plan stage {sid} does not list owned {cid}")
    elif "- none" not in block:
        fail(f"work plan stage {sid} must explicitly list no owned checks")

# Exact computed gates.
expected_gate_names=["alpha","beta","release_candidate","release"]
if list(gates.keys()) != expected_gate_names: fail(f"release gate names/order must be {expected_gate_names}")
stage_order={"foundation":0,"alpha":1,"beta":2,"release_candidate":3,"release":4}
check_order={"alpha":0,"beta":1,"release":2}
for gate in expected_gate_names:
    data=gates.get(gate,{})
    max_stage={"alpha":1,"beta":2,"release_candidate":3,"release":4}[gate]
    max_check={"alpha":0,"beta":1,"release_candidate":2,"release":2}[gate]
    expected_stages=[s["id"] for s in stages if stage_order[s["milestone"]] <= max_stage]
    expected_checks=[c["id"] for c in checks if check_order[c["mandatory_from"]] <= max_check]
    if data.get("required_stages") != expected_stages: fail(f"release gate {gate} stage list is not exact")
    if data.get("required_checks") != expected_checks: fail(f"release gate {gate} check list is not exact")

# Execution status shape. Planning validation does not require completion.
if execution.get("version") != "0.1": fail("execution status version must be 0.1")
exec_stages=execution.get("stages",{}); exec_checks=execution.get("verification_checks",{})
if list(exec_stages.keys()) != stage_ids: fail("execution status stage IDs/order must exactly match registry")
if list(exec_checks.keys()) != check_ids: fail("execution status check IDs/order must exactly match registry")
for sid,item in exec_stages.items():
    if item.get("status") not in {"not_started","in_progress","blocked","done"}: fail(f"execution stage {sid} invalid status")
    if not isinstance(item.get("accepted_by"),list) or not isinstance(item.get("evidence"),list): fail(f"execution stage {sid} accepted_by/evidence must be lists")
    if item.get("status")=="done" and (not item.get("accepted_by") or not item.get("evidence")): fail(f"done stage {sid} requires accepted_by and evidence")
for cid,item in exec_checks.items():
    if item.get("status") not in {"pending","running","blocked","passed","failed"}: fail(f"execution check {cid} invalid status")
    if not isinstance(item.get("evidence"),list): fail(f"execution check {cid} evidence must be list")
    if item.get("status")=="passed" and not item.get("evidence"): fail(f"passed check {cid} requires evidence")

# Required maintenance commands and README references.
for cmd in ("validate_planning.py","test_planning_validator.py","test_release_gate.py","check_release_gate.py"):
    if cmd not in maintenance or cmd not in (ROOT/'README.md').read_text(encoding='utf-8'):
        fail(f"maintenance guide and README must mention {cmd}")

if errors:
    print("Planning validation failed:")
    for e in errors: print(f"- {e}")
    sys.exit(1)
print(f"Planning validation passed: {len(stage_ids)} stages, {len(check_ids)} verification checks, {len(req_ids)} requirements")
print("DAG is acyclic")
print("Qualitative critical path: " + " -> ".join(critical))
print("Execution status shape is valid; milestone completion is checked separately")
