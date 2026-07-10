#!/usr/bin/env python3
"""Mutation tests proving that the planning validator rejects structural defects."""
from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Callable

import yaml

SOURCE_ROOT = Path(__file__).resolve().parents[1]
TRACE_REL = Path("docs/GitPM_Requirements_Traceability_v0.2.yaml")
VALIDATOR_REL = Path("scripts/validate_planning.py")


def copy_repo(target: Path) -> None:
    shutil.copytree(
        SOURCE_ROOT,
        target,
        ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "*.zip"),
        dirs_exist_ok=True,
    )


def run_validator(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(root / VALIDATOR_REL)],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def load_registry(root: Path) -> dict:
    return yaml.safe_load((root / TRACE_REL).read_text(encoding="utf-8"))


def save_registry(root: Path, data: dict) -> None:
    (root / TRACE_REL).write_text(
        yaml.safe_dump(data, allow_unicode=True, sort_keys=False, width=120),
        encoding="utf-8",
    )


def mutation_duplicate_stage(root: Path) -> None:
    data = load_registry(root)
    data["stages"].append(dict(data["stages"][0]))
    save_registry(root, data)


def mutation_cycle(root: Path) -> None:
    data = load_registry(root)
    data["stages"][0]["dependencies"] = ["P14"]
    save_registry(root, data)


def mutation_wrong_e2e_sequence(root: Path) -> None:
    data = load_registry(root)
    data["e2e"][0]["id"] = "E2E-999"
    save_registry(root, data)


def mutation_empty_acceptance(root: Path) -> None:
    data = load_registry(root)
    data["requirements"][0]["acceptance_criteria"] = []
    save_registry(root, data)


def mutation_inexact_release_gate(root: Path) -> None:
    data = load_registry(root)
    data["release_gates"]["alpha"]["required_e2e"] = data["release_gates"]["alpha"]["required_e2e"][:-1]
    save_registry(root, data)


def mutation_duplicate_yaml_key(root: Path) -> None:
    trace = root / TRACE_REL
    trace.write_text(trace.read_text(encoding="utf-8") + "\nversion: duplicate\n", encoding="utf-8")


MUTATIONS: list[tuple[str, Callable[[Path], None]]] = [
    ("duplicate stage ID", mutation_duplicate_stage),
    ("dependency cycle", mutation_cycle),
    ("wrong E2E sequence", mutation_wrong_e2e_sequence),
    ("empty acceptance criteria", mutation_empty_acceptance),
    ("inexact release gate", mutation_inexact_release_gate),
    ("duplicate YAML mapping key", mutation_duplicate_yaml_key),
]


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="gitpm-planning-selftest-") as temp:
        baseline = Path(temp) / "baseline"
        copy_repo(baseline)
        valid = run_validator(baseline)
        if valid.returncode != 0:
            print("Baseline validation unexpectedly failed:")
            print(valid.stdout)
            return 1

        for index, (name, mutate) in enumerate(MUTATIONS, start=1):
            case_root = Path(temp) / f"case-{index}"
            copy_repo(case_root)
            mutate(case_root)
            result = run_validator(case_root)
            if result.returncode == 0:
                print(f"Mutation was not detected: {name}")
                print(result.stdout)
                return 1
            print(f"PASS: validator rejected {name}")

    print(f"Planning validator self-test passed: {len(MUTATIONS)} mutations rejected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
