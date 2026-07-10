#!/usr/bin/env python3
"""Validate the active GitPM planning set and formal delivery registry."""
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
    "implementation": "GitPM_Implementation_Plan_v0.5.md",
    "work": "GitPM_Work_Plan_v0.4.md",
    "trace": "GitPM_Requirements_Traceability_v0.3.yaml",
    "delivery": "GitPM_Delivery_Policies_v0.3.md",
    "security": "GitPM_Security_Baseline_v0.3.md",
    "maintenance": "GitPM_Planning_Maintenance_Guide_v0.1.md",
    "progress": "PROGRESS.md",
}
EXPECTED_E2E_COUNT = 32
errors: list[str] = []


class UniqueKeyLoader(yaml.SafeLoader):
    """Safe YAML loader rejecting duplicate mapping keys."""


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


UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


def fail(message: str) -> None:
    errors.append(message)


def read_doc(key: str) -> str:
    path = DOCS / EXPECTED[key]
    if not path.is_file():
        fail(f"missing required document: docs/{EXPECTED[key]}")
        return ""
    return path.read_text(encoding="utf-8")


for name in EXPECTED.values():
    if not (DOCS / name).is_file():
        fail(f"missing required file: docs/{name}")
if not (ROOT / "README.md").is_file():
    fail("missing README.md")
if errors:
    print("Planning validation failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)

implementation = read_doc("implementation")
work = read_doc("work")
delivery = read_doc("delivery")
security = read_doc("security")
maintenance = read_doc("maintenance")
progress = read_doc("progress")
readme = (ROOT / "README.md").read_text(encoding="utf-8")

try:
    registry = yaml.load((DOCS / EXPECTED["trace"]).read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
except Exception as exc:  # noqa: BLE001
    fail(f"traceability YAML parse failed: {exc}")
    registry = {}
if not isinstance(registry, dict):
    fail("traceability root must be a mapping")
    registry = {}

# Exactly one active version of each planning family.
families = {
    "GitPM_Implementation_Plan_v*.md": EXPECTED["implementation"],
    "GitPM_Work_Plan_v*.md": EXPECTED["work"],
    "GitPM_Requirements_Traceability_v*.yaml": EXPECTED["trace"],
    "GitPM_Delivery_Policies_v*.md": EXPECTED["delivery"],
    "GitPM_Security_Baseline_v*.md": EXPECTED["security"],
    "GitPM_Planning_Maintenance_Guide_v*.md": EXPECTED["maintenance"],
}
for pattern, expected in families.items():
    actual = sorted(path.name for path in DOCS.glob(pattern))
    if actual != [expected]:
        fail(f"active files for {pattern}: expected [{expected}], got {actual}")

expected_doc_map = {
    "implementation_plan": EXPECTED["implementation"],
    "work_plan": EXPECTED["work"],
    "delivery_policies": EXPECTED["delivery"],
    "security_baseline": EXPECTED["security"],
    "maintenance_guide": EXPECTED["maintenance"],
    "progress": EXPECTED["progress"],
}
if registry.get("documents") != expected_doc_map:
    fail(f"registry documents mismatch: expected {expected_doc_map}, got {registry.get('documents')}")
if registry.get("version") != "0.3":
    fail("traceability version must be 0.3")

stages = registry.get("stages", [])
requirements = registry.get("requirements", [])
e2e = registry.get("e2e", [])
gates = registry.get("release_gates", {})
for label, value in (("stages", stages), ("requirements", requirements), ("e2e", e2e)):
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
requirement_ids = collect_ids(requirements, "requirement")
e2e_ids = collect_ids(e2e, "E2E")
stage_set, requirement_set, e2e_set = set(stage_ids), set(requirement_ids), set(e2e_ids)
expected_e2e = [f"E2E-{index:03d}" for index in range(1, EXPECTED_E2E_COUNT + 1)]
if e2e_ids != expected_e2e:
    fail(f"E2E list must be exactly ordered E2E-001 through E2E-{EXPECTED_E2E_COUNT:03d}")

# Stage schema and DAG.
size_weight = {"S": 1, "M": 2, "L": 3}
stage_by_id: dict[str, dict[str, Any]] = {}
adjacency: dict[str, list[str]] = defaultdict(list)
indegree = {stage_id: 0 for stage_id in stage_ids}
for stage in stages:
    if not isinstance(stage, dict) or not isinstance(stage.get("id"), str):
        continue
    stage_id = stage["id"]
    stage_by_id[stage_id] = stage
    for field in ("title", "size", "estimate", "dependencies", "accountable", "responsible", "acceptance", "milestone"):
        if field not in stage:
            fail(f"stage {stage_id} missing field {field}")
    if stage.get("size") not in size_weight:
        fail(f"stage {stage_id} size must be S/M/L")
    if not isinstance(stage.get("accountable"), str) or not stage.get("accountable"):
        fail(f"stage {stage_id} must have one accountable")
    for field in ("responsible", "acceptance"):
        if not isinstance(stage.get(field), list) or not stage.get(field):
            fail(f"stage {stage_id} {field} must be non-empty list")
    deps = stage.get("dependencies")
    if not isinstance(deps, list):
        fail(f"stage {stage_id} dependencies must be list")
        continue
    if len(deps) != len(set(deps)):
        fail(f"stage {stage_id} has duplicate dependencies")
    for dep in deps:
        if dep == stage_id:
            fail(f"stage {stage_id} depends on itself")
        elif dep not in stage_set:
            fail(f"stage {stage_id} references unknown dependency {dep}")
        else:
            adjacency[dep].append(stage_id)
            indegree[stage_id] += 1

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
    fail(f"stage DAG contains cycle: {sorted(k for k, v in indegree.items() if v > 0)}")

# Calculate critical path; it is derived, never maintained manually.
score: dict[str, int] = {}
pred: dict[str, str | None] = {}
for stage_id in topological:
    stage = stage_by_id[stage_id]
    deps = stage.get("dependencies", [])
    weight = size_weight.get(stage.get("size"), 0)
    if not deps:
        score[stage_id], pred[stage_id] = weight, None
    else:
        best = max(deps, key=lambda dep: score.get(dep, -1))
        score[stage_id], pred[stage_id] = score[best] + weight, best
critical: list[str] = []
if score:
    node: str | None = max(score, key=score.get)
    while node:
        critical.append(node)
        node = pred[node]
    critical.reverse()

# Work plan headings and required sections.
markdown_stage_ids = re.findall(r"^## (P[0-9A-Z]+)\.", work, flags=re.M)
if markdown_stage_ids != stage_ids:
    fail("work plan stage heading order/set must exactly match registry")
for stage_id, stage in stage_by_id.items():
    heading = f"## {stage_id}. {stage.get('title')}"
    if work.count(heading) != 1:
        fail(f"work plan must contain exact heading once: {heading}")
for section in ("### Objective", "### Entry criteria", "### Work packages", "### Artifacts", "### Automated verification", "### Manual acceptance", "### Owned E2E", "### Exit gate"):
    if work.count(section) != len(stage_ids):
        fail(f"work plan section count mismatch for {section}")
if "Параллельность:" in work:
    fail("manual parallelism field is prohibited")

# Requirements and bidirectional links.
requirement_by_id: dict[str, dict[str, Any]] = {}
for req in requirements:
    if not isinstance(req, dict) or not isinstance(req.get("id"), str):
        continue
    req_id = req["id"]
    requirement_by_id[req_id] = req
    for field in ("description", "source", "owner", "stage", "release_gate", "acceptance_criteria", "tests"):
        if field not in req:
            fail(f"requirement {req_id} missing {field}")
    if req.get("stage") not in stage_set:
        fail(f"requirement {req_id} references unknown stage")
    if req.get("release_gate") not in {"alpha", "beta", "release"}:
        fail(f"requirement {req_id} invalid release_gate")
    if not isinstance(req.get("acceptance_criteria"), list) or not req.get("acceptance_criteria"):
        fail(f"requirement {req_id} acceptance_criteria must be non-empty")
    if not isinstance(req.get("tests"), list) or not req.get("tests"):
        fail(f"requirement {req_id} tests must be non-empty")
    source = req.get("source")
    if not isinstance(source, dict) or source.get("document") != EXPECTED["implementation"] or not source.get("section"):
        fail(f"requirement {req_id} source must point to active implementation and a section")
    for test_id in req.get("tests", []):
        if test_id not in e2e_set:
            fail(f"requirement {req_id} references unknown E2E {test_id}")

# E2E structure. No live GitLab environment is allowed by this revision.
valid_envs = {"ci-clean-linux", "integration-local", "fault-local", "security-local", "browser-local", "agent-local", "perf-local"}
e2e_by_id: dict[str, dict[str, Any]] = {}
for test in e2e:
    if not isinstance(test, dict) or not isinstance(test.get("id"), str):
        continue
    test_id = test["id"]
    e2e_by_id[test_id] = test
    for field in ("title", "stage", "mandatory_from", "environment", "actor", "preconditions", "steps", "expected_result", "evidence", "requirements"):
        if field not in test:
            fail(f"{test_id} missing field {field}")
    if test.get("stage") not in stage_set:
        fail(f"{test_id} references unknown stage")
    if test.get("mandatory_from") not in {"alpha", "beta", "release"}:
        fail(f"{test_id} invalid mandatory_from")
    if test.get("environment") not in valid_envs:
        fail(f"{test_id} invalid environment {test.get('environment')}")
    for field in ("preconditions", "steps", "expected_result", "evidence", "requirements"):
        if not isinstance(test.get(field), list) or not test.get(field):
            fail(f"{test_id} {field} must be a non-empty list")
    for req_id in test.get("requirements", []):
        if req_id not in requirement_set:
            fail(f"{test_id} references unknown requirement {req_id}")
        elif test_id not in requirement_by_id[req_id].get("tests", []):
            fail(f"bidirectional link missing: {test_id} -> {req_id}")

for req_id, req in requirement_by_id.items():
    for test_id in req.get("tests", []):
        if req_id not in e2e_by_id.get(test_id, {}).get("requirements", []):
            fail(f"bidirectional link missing: {req_id} -> {test_id}")

# Owned E2E must appear in the owning Work Plan stage.
for stage_id in stage_ids:
    owned = [test["id"] for test in e2e if test.get("stage") == stage_id]
    heading_start = work.index(f"## {stage_id}. ")
    next_positions = [work.find(f"## {next_id}. ", heading_start + 1) for next_id in stage_ids if work.find(f"## {next_id}. ", heading_start + 1) != -1]
    stage_text = work[heading_start:min(next_positions) if next_positions else len(work)]
    for test_id in owned:
        if f"`{test_id}`" not in stage_text:
            fail(f"work plan stage {stage_id} does not list owned {test_id}")

# Exact release gates.
expected_gate_names = ["alpha", "beta", "release_candidate", "release"]
if list(gates.keys()) != expected_gate_names:
    fail(f"release gate names/order must be {expected_gate_names}")
stage_order = {"foundation": 0, "alpha": 1, "beta": 2, "release_candidate": 3, "release": 4}
test_order = {"alpha": 0, "beta": 1, "release": 2}
for gate in expected_gate_names:
    data = gates.get(gate, {})
    if not isinstance(data, dict):
        fail(f"release gate {gate} must be mapping")
        continue
    if gate == "alpha":
        max_stage, max_test = 1, 0
    elif gate == "beta":
        max_stage, max_test = 2, 1
    elif gate == "release_candidate":
        max_stage, max_test = 3, 2
    else:
        max_stage, max_test = 4, 2
    expected_stages = [stage["id"] for stage in stages if stage_order[stage["milestone"]] <= max_stage]
    expected_tests = [test["id"] for test in e2e if test_order[test["mandatory_from"]] <= max_test]
    if data.get("required_stages") != expected_stages:
        fail(f"release gate {gate} stage list is not exact")
    if data.get("required_e2e") != expected_tests:
        fail(f"release gate {gate} E2E list is not exact")

# Product simplification boundaries.
required_phrases = {
    implementation: [
        "отдельного display key нет",
        "Migration engine в v0.1 отсутствует",
        "local safety refs",
        "GitPM не выполняет rebase",
        "MCP server, agent domain API",
        "Обязательного live GitLab test project",
        "Gantt только читает",
    ],
    delivery: ["Нет собственного authorization DSL", "Нет `gitpm migrate`" if False else "Migration engine отсутствует", "Нет limits по пользователям"],
    maintenance: ["Порядок изменения", "Verification commands", "Как закрывать stage"],
}
for text, phrases in required_phrases.items():
    for phrase in phrases:
        if phrase not in text:
            fail(f"required planning phrase missing: {phrase}")

prohibited_patterns = {
    r"/git/restore/lines": "selected-lines restore endpoint",
    r"/rebase(?:/|\b)": "rebase API route",
    r"## P10B\.": "rebase stage",
    r"refs/gitpm/safety": "safety ref implementation",
    r"gitpm migrate --": "migration command",
    r"\bMCP tools\b": "MCP tool registry",
    r"environment:\s*(?:real-gitlab|security-real-gitlab|agent-real-gitlab)": "live GitLab E2E environment",
    r"display_key\s*:": "display key field",
}
combined = "\n".join((implementation, work, delivery, security, (DOCS / EXPECTED["trace"]).read_text(encoding="utf-8")))
for pattern, label in prohibited_patterns.items():
    if re.search(pattern, combined, flags=re.I | re.M):
        fail(f"superseded feature still present: {label}")

if "No backup and no safety refs" not in readme:
    fail("README must state no backup and no safety refs")
if "live GitLab test project is not required" not in progress:
    fail("PROGRESS must state live GitLab test is not required")

# References in README, PROGRESS and maintenance guide.
for key, filename in EXPECTED.items():
    if key == "progress":
        continue
    if filename not in readme:
        fail(f"README does not reference {filename}")
    if filename not in progress:
        fail(f"PROGRESS does not reference {filename}")
for filename in EXPECTED.values():
    if filename not in maintenance and filename != EXPECTED["maintenance"]:
        # The guide describes families; exact PROGRESS and active names should still be discoverable.
        if filename != "PROGRESS.md":
            fail(f"maintenance guide does not reference active {filename}")
if "PROGRESS.md" not in maintenance:
    fail("maintenance guide does not explain PROGRESS.md")

if errors:
    print("Planning validation failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)

print(
    "Planning validation passed: "
    f"{len(stage_ids)} stages, {len(e2e_ids)} structured E2E tests, "
    f"{len(requirement_ids)} requirements; DAG critical path: {' -> '.join(critical)}"
)
