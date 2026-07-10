#!/usr/bin/env python3
"""Strict validation for GitPM planning documents and formal delivery registry."""
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
    "implementation": "GitPM_Implementation_Plan_v0.4.md",
    "work": "GitPM_Work_Plan_v0.3.md",
    "trace": "GitPM_Requirements_Traceability_v0.2.yaml",
    "delivery": "GitPM_Delivery_Policies_v0.2.md",
    "security": "GitPM_Security_Baseline_v0.2.md",
    "progress": "PROGRESS.md",
}

errors: list[str] = []


class UniqueKeyLoader(yaml.SafeLoader):
    """YAML loader that rejects duplicate mapping keys."""


def _construct_mapping(loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"duplicate key: {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_mapping,
)


def read_text(name: str) -> str:
    path = DOCS / name
    if not path.is_file():
        errors.append(f"missing required document: docs/{name}")
        return ""
    return path.read_text(encoding="utf-8")


for name in EXPECTED.values():
    if not (DOCS / name).is_file():
        errors.append(f"missing required file: docs/{name}")

if not (ROOT / "README.md").is_file():
    errors.append("missing README.md")

if errors:
    print("Planning validation failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)

implementation = read_text(EXPECTED["implementation"])
work = read_text(EXPECTED["work"])
delivery = read_text(EXPECTED["delivery"])
security = read_text(EXPECTED["security"])
progress = read_text(EXPECTED["progress"])
readme = (ROOT / "README.md").read_text(encoding="utf-8")

try:
    registry = yaml.load((DOCS / EXPECTED["trace"]).read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
except Exception as exc:  # noqa: BLE001 - validator must report parse failure
    errors.append(f"traceability YAML parse failed: {exc}")
    registry = {}

if not isinstance(registry, dict):
    errors.append("traceability root must be a mapping")
    registry = {}

# Exactly one active version per versioned plan family.
families = {
    "GitPM_Implementation_Plan_v*.md": EXPECTED["implementation"],
    "GitPM_Work_Plan_v*.md": EXPECTED["work"],
    "GitPM_Requirements_Traceability_v*.yaml": EXPECTED["trace"],
    "GitPM_Delivery_Policies_v*.md": EXPECTED["delivery"],
    "GitPM_Security_Baseline_v*.md": EXPECTED["security"],
}
for pattern, expected_name in families.items():
    active = sorted(p.name for p in DOCS.glob(pattern))
    if active != [expected_name]:
        errors.append(f"active files for {pattern}: expected [{expected_name}], got {active}")

# Registry document pointers must exactly match active files.
documents = registry.get("documents", {})
expected_doc_map = {
    "implementation_plan": EXPECTED["implementation"],
    "work_plan": EXPECTED["work"],
    "delivery_policies": EXPECTED["delivery"],
    "security_baseline": EXPECTED["security"],
    "progress": EXPECTED["progress"],
}
if documents != expected_doc_map:
    errors.append(f"registry documents mismatch: expected {expected_doc_map}, got {documents}")

stages = registry.get("stages", [])
requirements = registry.get("requirements", [])
e2e = registry.get("e2e", [])
gates = registry.get("release_gates", {})

for label, value in (("stages", stages), ("requirements", requirements), ("e2e", e2e)):
    if not isinstance(value, list) or not value:
        errors.append(f"registry {label} must be a non-empty list")


def duplicate_ids(items: list[dict[str, Any]], label: str) -> list[str]:
    ids = [item.get("id") for item in items if isinstance(item, dict)]
    duplicates = sorted(key for key, count in Counter(ids).items() if key is not None and count > 1)
    if duplicates:
        errors.append(f"duplicate {label} IDs: {duplicates}")
    if any(not isinstance(key, str) or not key for key in ids):
        errors.append(f"{label} contains missing/invalid id")
    return [key for key in ids if isinstance(key, str)]


stage_ids = duplicate_ids(stages, "stage")
requirement_ids = duplicate_ids(requirements, "requirement")
e2e_ids = duplicate_ids(e2e, "E2E")
stage_set = set(stage_ids)
requirement_set = set(requirement_ids)
e2e_set = set(e2e_ids)

expected_e2e = [f"E2E-{index:03d}" for index in range(1, 46)]
if e2e_ids != expected_e2e:
    errors.append("E2E list must be exactly ordered E2E-001 through E2E-045")

# Stage schema, accountability and DAG.
size_weight = {"S": 1, "M": 2, "L": 3}
stage_by_id: dict[str, dict[str, Any]] = {}
adjacency: dict[str, list[str]] = defaultdict(list)
indegree: dict[str, int] = {stage_id: 0 for stage_id in stage_ids}
for stage in stages:
    if not isinstance(stage, dict):
        errors.append("stage entry is not a mapping")
        continue
    stage_id = stage.get("id")
    if not isinstance(stage_id, str):
        continue
    stage_by_id[stage_id] = stage
    required_fields = ["title", "size", "estimate", "dependencies", "accountable", "responsible", "acceptance", "milestone"]
    for field in required_fields:
        if field not in stage:
            errors.append(f"stage {stage_id} missing field {field}")
    if stage.get("size") not in size_weight:
        errors.append(f"stage {stage_id} size must be S/M/L and never XL")
    accountable = stage.get("accountable")
    if not isinstance(accountable, str) or not accountable or "/" in accountable or "," in accountable:
        errors.append(f"stage {stage_id} must have one accountable owner")
    for field in ("responsible", "acceptance"):
        if not isinstance(stage.get(field), list) or not stage.get(field):
            errors.append(f"stage {stage_id} {field} must be a non-empty list")
    deps = stage.get("dependencies", [])
    if not isinstance(deps, list):
        errors.append(f"stage {stage_id} dependencies must be a list")
        continue
    if len(deps) != len(set(deps)):
        errors.append(f"stage {stage_id} has duplicate dependencies")
    for dep in deps:
        if dep == stage_id:
            errors.append(f"stage {stage_id} depends on itself")
        elif dep not in stage_set:
            errors.append(f"stage {stage_id} references unknown dependency {dep}")
        else:
            adjacency[dep].append(stage_id)
            indegree[stage_id] += 1

# Topological order and cycle detection.
queue = deque(sorted(stage_id for stage_id, degree in indegree.items() if degree == 0))
topological: list[str] = []
while queue:
    current = queue.popleft()
    topological.append(current)
    for nxt in sorted(adjacency[current]):
        indegree[nxt] -= 1
        if indegree[nxt] == 0:
            queue.append(nxt)
if len(topological) != len(stage_ids):
    cyclic = sorted(stage_id for stage_id, degree in indegree.items() if degree > 0)
    errors.append(f"stage dependency graph contains a cycle involving: {cyclic}")

# Longest weighted path for useful output, not a second manually maintained source.
longest_score: dict[str, int] = {}
predecessor: dict[str, str | None] = {}
for stage_id in topological:
    weight = size_weight.get(stage_by_id.get(stage_id, {}).get("size"), 0)
    deps = stage_by_id.get(stage_id, {}).get("dependencies", [])
    if not deps:
        longest_score[stage_id] = weight
        predecessor[stage_id] = None
    else:
        best_dep = max(deps, key=lambda dep: longest_score.get(dep, -1))
        longest_score[stage_id] = longest_score.get(best_dep, 0) + weight
        predecessor[stage_id] = best_dep
critical_path: list[str] = []
if longest_score:
    node: str | None = max(longest_score, key=longest_score.get)
    while node is not None:
        critical_path.append(node)
        node = predecessor.get(node)
    critical_path.reverse()

# Work Plan stage headings must exactly match registry titles and appear once.
for stage_id, stage in stage_by_id.items():
    heading = f"## {stage_id}. {stage.get('title')}"
    count = work.count(heading)
    if count != 1:
        errors.append(f"work plan must contain stage heading once: {heading!r}, found {count}")
if re.search(r"^## P[0-9A-Z]+\.", work, flags=re.M):
    markdown_stage_ids = re.findall(r"^## (P[0-9A-Z]+)\.", work, flags=re.M)
    if set(markdown_stage_ids) != stage_set or len(markdown_stage_ids) != len(stage_ids):
        errors.append("work plan stage heading set does not exactly match registry")
if "Параллельность:" in work or "API contract P06" in work:
    errors.append("work plan contains non-formal parallelism/partial-dependency text")

# E2E schema and ownership.
valid_mandatory = {"alpha", "beta", "release"}
valid_environments = {
    "real-gitlab", "security-real-gitlab", "agent-real-gitlab", "browser-local",
    "integration-local", "fault-local", "security-local", "agent-local",
    "perf-runner", "ci-clean-linux",
}
e2e_by_id: dict[str, dict[str, Any]] = {}
for test in e2e:
    if not isinstance(test, dict):
        errors.append("E2E entry is not a mapping")
        continue
    test_id = test.get("id")
    if not isinstance(test_id, str):
        continue
    e2e_by_id[test_id] = test
    for field in ("title", "stage", "mandatory_from", "environment", "actor", "preconditions", "steps", "expected_result", "evidence", "requirements"):
        if field not in test:
            errors.append(f"{test_id} missing field {field}")
    if test.get("stage") not in stage_set:
        errors.append(f"{test_id} references unknown stage {test.get('stage')}")
    if test.get("mandatory_from") not in valid_mandatory:
        errors.append(f"{test_id} invalid mandatory_from {test.get('mandatory_from')}")
    if test.get("environment") not in valid_environments:
        errors.append(f"{test_id} invalid environment {test.get('environment')}")
    for field in ("preconditions", "steps", "expected_result", "evidence", "requirements"):
        value = test.get(field)
        if not isinstance(value, list) or not value:
            errors.append(f"{test_id} {field} must be a non-empty list")
    for req_id in test.get("requirements", []):
        if req_id not in requirement_set:
            errors.append(f"{test_id} references unknown requirement {req_id}")
    if work.count(f"- `{test_id}`") != 1:
        errors.append(f"work plan must list owned E2E exactly once: {test_id}")

# Requirements schema, source references and bidirectional links.
requirement_by_id: dict[str, dict[str, Any]] = {}
for requirement in requirements:
    if not isinstance(requirement, dict):
        errors.append("requirement entry is not a mapping")
        continue
    req_id = requirement.get("id")
    if not isinstance(req_id, str):
        continue
    requirement_by_id[req_id] = requirement
    for field in ("description", "source", "owner", "stage", "release_gate", "acceptance_criteria", "tests"):
        if field not in requirement:
            errors.append(f"requirement {req_id} missing field {field}")
    if requirement.get("stage") not in stage_set:
        errors.append(f"requirement {req_id} references unknown stage {requirement.get('stage')}")
    if requirement.get("release_gate") not in {"alpha", "beta", "release"}:
        errors.append(f"requirement {req_id} has invalid release_gate")
    for field in ("acceptance_criteria", "tests"):
        value = requirement.get(field)
        if not isinstance(value, list) or not value:
            errors.append(f"requirement {req_id} {field} must be a non-empty list")
    source = requirement.get("source")
    if not isinstance(source, dict) or not source.get("document") or not source.get("section"):
        errors.append(f"requirement {req_id} source must contain document and section")
    else:
        source_path = DOCS / str(source["document"])
        if not source_path.is_file():
            errors.append(f"requirement {req_id} source document missing: {source['document']}")
        else:
            source_text = source_path.read_text(encoding="utf-8")
            if not re.search(rf"^## {re.escape(str(source['section']))}(?:\.|\s)", source_text, flags=re.M):
                errors.append(f"requirement {req_id} source section not found: {source['document']} section {source['section']}")
    for test_id in requirement.get("tests", []):
        if test_id not in e2e_set:
            errors.append(f"requirement {req_id} references unknown test {test_id}")
        else:
            test_gate = e2e_by_id.get(test_id, {}).get("mandatory_from")
            requirement_gate = requirement.get("release_gate")
            if test_gate in {"alpha", "beta", "release"} and requirement_gate in {"alpha", "beta", "release"}:
                local_gate_order = {"alpha": 0, "beta": 1, "release": 2}
                if local_gate_order[test_gate] > local_gate_order[requirement_gate]:
                    errors.append(
                        f"requirement {req_id} is due at {requirement_gate} but test {test_id} is only mandatory from {test_gate}"
                    )
            if req_id not in e2e_by_id.get(test_id, {}).get("requirements", []):
                errors.append(f"bidirectional link missing: {req_id} -> {test_id} but E2E does not link back")

for test_id, test in e2e_by_id.items():
    for req_id in test.get("requirements", []):
        if test_id not in requirement_by_id.get(req_id, {}).get("tests", []):
            errors.append(f"bidirectional link missing: {test_id} -> {req_id} but requirement does not link back")

# Milestone compatibility.
stage_milestone_order = {"foundation": 0, "alpha": 1, "beta": 2, "release_candidate": 3, "release": 4}
gate_order = {"alpha": 1, "beta": 2, "release": 4}
for test_id, test in e2e_by_id.items():
    stage = stage_by_id.get(test.get("stage"), {})
    stage_order = stage_milestone_order.get(stage.get("milestone"), 99)
    if stage_order > gate_order.get(test.get("mandatory_from"), -1):
        errors.append(f"{test_id} is mandatory from {test.get('mandatory_from')} before owner stage {test.get('stage')} completes")
for req_id, requirement in requirement_by_id.items():
    stage = stage_by_id.get(requirement.get("stage"), {})
    stage_order = stage_milestone_order.get(stage.get("milestone"), 99)
    if stage_order > gate_order.get(requirement.get("release_gate"), -1):
        errors.append(f"requirement {req_id} gate precedes owning stage")

# Exact release gates and dependency closure.
expected_gate_names = ["alpha", "beta", "release_candidate", "release"]
if list(gates.keys()) != expected_gate_names:
    errors.append(f"release gate order/names must be {expected_gate_names}")
mandatory_order = {"alpha": 0, "beta": 1, "release": 2}
for gate_name in expected_gate_names:
    gate = gates.get(gate_name, {})
    if not isinstance(gate, dict):
        errors.append(f"release gate {gate_name} must be a mapping")
        continue
    required_stages = gate.get("required_stages")
    required_tests = gate.get("required_e2e")
    if not isinstance(required_stages, list) or not isinstance(required_tests, list):
        errors.append(f"release gate {gate_name} requires stage and E2E lists")
        continue
    if len(required_stages) != len(set(required_stages)):
        errors.append(f"release gate {gate_name} has duplicate stages")
    if len(required_tests) != len(set(required_tests)):
        errors.append(f"release gate {gate_name} has duplicate E2E")
    for stage_id in required_stages:
        if stage_id not in stage_set:
            errors.append(f"release gate {gate_name} unknown stage {stage_id}")
        else:
            missing_deps = set(stage_by_id[stage_id].get("dependencies", [])) - set(required_stages)
            if missing_deps:
                errors.append(f"release gate {gate_name} stage {stage_id} missing dependency closure {sorted(missing_deps)}")
    for test_id in required_tests:
        if test_id not in e2e_set:
            errors.append(f"release gate {gate_name} unknown E2E {test_id}")
    if gate_name == "alpha":
        expected_tests = [t["id"] for t in e2e if mandatory_order[t["mandatory_from"]] <= mandatory_order["alpha"]]
        expected_stages = [s["id"] for s in stages if stage_milestone_order[s["milestone"]] <= 1]
    elif gate_name == "beta":
        expected_tests = [t["id"] for t in e2e if mandatory_order[t["mandatory_from"]] <= mandatory_order["beta"]]
        expected_stages = [s["id"] for s in stages if stage_milestone_order[s["milestone"]] <= 2]
    elif gate_name == "release_candidate":
        expected_tests = e2e_ids
        expected_stages = [s["id"] for s in stages if stage_milestone_order[s["milestone"]] <= 3]
    else:
        expected_tests = e2e_ids
        expected_stages = stage_ids
    if required_tests != expected_tests:
        errors.append(f"release gate {gate_name} E2E list is not exact")
    if required_stages != expected_stages:
        errors.append(f"release gate {gate_name} stage list is not exact")

# Architecture consistency and removal of superseded decisions.
prohibited_impl_patterns = {
    r"/git/restore/lines": "selected-lines restore endpoint is present",
    r"GITPM_TOKEN_ENCRYPTION_KEY": "production key environment variable is present",
    r":taskKey": "mutation route still uses taskKey",
    r":projectKey": "mutation route still uses projectKey",
    r"TSK-\d+\.yaml": "filename example still uses display key",
    r"depends_on:\s*$": "internal reference example uses old depends_on field",
    r"project:\s+PRJ-": "internal reference example uses display project key",
}
for pattern, message in prohibited_impl_patterns.items():
    if re.search(pattern, implementation, flags=re.M):
        errors.append(f"implementation inconsistency: {message}")

required_phrases = [
    "Alpha и MVP означают один и тот же milestone",
    "GitPM v0.1 не делает резервных копий",
    "Потеря всего persistent volume означает потерю",
    "immutable technical ID",
    "Display key",
]
for phrase in required_phrases:
    if phrase not in implementation:
        errors.append(f"implementation plan missing required decision phrase: {phrase}")

if "Параллельность:" in work:
    errors.append("manual parallelism field is prohibited")
if "backup remote" in work.lower() or "backup scheduler" in work.lower():
    errors.append("work plan contains backup implementation")
if "No backup subsystem in v0.1" not in readme:
    errors.append("README does not state no-backup product boundary")
if "local safety ref is not a backup" not in delivery:
    errors.append("delivery policy does not distinguish local safety ref from backup")
if "There is no backup process trust boundary" not in security:
    errors.append("security baseline still models a backup subsystem")

# Current-document references in README and PROGRESS.
for current_name in EXPECTED.values():
    if current_name == "PROGRESS.md":
        continue
    if current_name not in readme:
        errors.append(f"README does not reference {current_name}")
    if current_name not in progress:
        errors.append(f"PROGRESS does not reference {current_name}")

# Prevent vague release gates in executable plan.
for vague in ("relevant subset", "где применимо", "если доступен"):
    if vague.lower() in work.lower():
        errors.append(f"work plan contains vague gate wording: {vague}")

if errors:
    print("Planning validation failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)

print(
    "Planning validation passed: "
    f"{len(stage_ids)} stages, {len(e2e_ids)} structured E2E tests, "
    f"{len(requirement_ids)} requirements; DAG critical path: {' -> '.join(critical_path)}"
)
