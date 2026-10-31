#!/usr/bin/env python3
"""
Canonical worktree-audit serializer for iKuck.

Produces a manifest digest of:
- Branch/HEAD info
- All tracked files (with SHA256 hashes)
- All untracked files (with SHA256 hashes)
- Excludes sensitive files without reading/hashing them

Writes manifest to a private mode-0600 file.
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple


SENSITIVE_PATTERNS = [
    ".env",
    ".env.*",
    "*.key",
    "*.pem",
    "*.crt",
    "*.cer",
    "*.pfx",
    "*.p12",
    "*secret*",
    "*password*",
    "*token*",
    "id_rsa*",
    "id_ed25519*",
    "*.priv",
    "*.private",
    "secrets.*",
    "credentials.*",
]

# Directories to exclude entirely
EXCLUDE_DIRS = {
    "node_modules",
    ".git",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    ".next",
    "coverage",
    ".nyc_output",
    "test-results",
    ".vscode",
    ".idea",
}

# Files to exclude entirely (by name)
EXCLUDE_FILES = {
    ".DS_Store",
    "Thumbs.db",
    "*.log",
    "*.tmp",
    "*.temp",
    "*.swp",
    "*.swo",
}


def run_git_command(args: List[str], cwd: Path) -> str:
    """Run a git command and return stdout."""
    result = subprocess.run(
        ["git"] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def is_sensitive(path: Path, repo_root: Path) -> bool:
    """Check if a file path matches sensitive patterns."""
    rel_path = path.relative_to(repo_root)
    rel_str = str(rel_path)
    name = path.name

    # Check directory exclusions
    for part in rel_path.parts:
        if part in EXCLUDE_DIRS:
            return True

    # Check file exclusions
    for pattern in EXCLUDE_FILES:
        if pattern.startswith("*") and name.endswith(pattern[1:]):
            return True
        if pattern == name:
            return True

    # Check sensitive patterns
    for pattern in SENSITIVE_PATTERNS:
        if pattern.startswith("*") and pattern.endswith("*"):
            # *pattern* - contains
            if pattern[1:-1] in rel_str:
                return True
        elif pattern.startswith("*"):
            # *pattern - ends with
            if rel_str.endswith(pattern[1:]) or name.endswith(pattern[1:]):
                return True
        elif pattern.endswith("*"):
            # pattern* - starts with
            if rel_str.startswith(pattern[:-1]) or name.startswith(pattern[:-1]):
                return True
        else:
            # exact match
            if rel_str == pattern or name == pattern:
                return True

    return False


def get_file_hash(filepath: Path) -> str:
    """Compute SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def get_tracked_files(repo_root: Path) -> List[Path]:
    """Get all tracked files from git."""
    output = run_git_command(["ls-files", "-z"], repo_root)
    if not output:
        return []
    files = output.split("\x00")
    return [repo_root / f for f in files if f]


def get_untracked_files(repo_root: Path) -> List[Path]:
    """Get all untracked files from git status."""
    output = run_git_command(["status", "--porcelain", "-z", "--untracked-files=all"], repo_root)
    if not output:
        return []
    files = []
    for line in output.split("\x00"):
        if not line:
            continue
        # Format: "?? filename" for untracked
        if line.startswith("??"):
            filename = line[3:]
            files.append(repo_root / filename)
    return files


def get_git_info(repo_root: Path) -> Dict:
    """Get branch and HEAD information."""
    branch = run_git_command(["branch", "--show-current"], repo_root)
    head = run_git_command(["rev-parse", "HEAD"], repo_root)
    head_short = run_git_command(["rev-parse", "--short=12", "HEAD"], repo_root)
    return {
        "branch": branch,
        "head": head,
        "head_short": head_short,
    }


def collect_manifest(repo_root: Path) -> Tuple[Dict, str]:
    """Collect the full worktree manifest and compute its digest."""
    git_info = get_git_info(repo_root)

    tracked_files = get_tracked_files(repo_root)
    untracked_files = get_untracked_files(repo_root)

    all_files = tracked_files + untracked_files

    manifest_entries = []
    sensitive_excluded = []

    for filepath in sorted(all_files):
        try:
            rel_path = filepath.relative_to(repo_root)
        except ValueError:
            continue

        if is_sensitive(filepath, repo_root):
            sensitive_excluded.append(str(rel_path))
            manifest_entries.append({
                "path": str(rel_path),
                "status": "excluded_sensitive",
                "hash": None,
                "size": None,
            })
            continue

        if not filepath.exists() or not filepath.is_file():
            continue

        try:
            file_hash = get_file_hash(filepath)
            file_size = filepath.stat().st_size
            manifest_entries.append({
                "path": str(rel_path),
                "status": "tracked" if filepath in tracked_files else "untracked",
                "hash": file_hash,
                "size": file_size,
            })
        except (OSError, IOError) as e:
            manifest_entries.append({
                "path": str(rel_path),
                "status": "error",
                "hash": None,
                "size": None,
                "error": str(e),
            })

    manifest = {
        "git": git_info,
        "files": manifest_entries,
        "sensitive_excluded_count": len(sensitive_excluded),
        "sensitive_excluded_paths": sensitive_excluded,
    }

    # Compute digest of the manifest (excluding the digest field itself)
    manifest_json = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(manifest_json.encode()).hexdigest()

    manifest["manifest_digest"] = digest

    return manifest, digest


def write_manifest(manifest: Dict, output_path: Path) -> None:
    """Write manifest to file with mode 0600."""
    # Ensure parent directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write with restricted permissions
    with open(output_path, "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)

    # Set permissions to 0600 (owner read/write only)
    os.chmod(output_path, 0o600)


def main():
    repo_root = Path.cwd()
    if len(sys.argv) > 1:
        repo_root = Path(sys.argv[1]).resolve()

    if not (repo_root / ".git").exists() and not (repo_root / ".git").is_file():
        print(f"Error: {repo_root} is not a git repository", file=sys.stderr)
        sys.exit(1)

    # Default output path: .worktree-audit-<HEAD_SHORT>.json in repo root
    git_info = get_git_info(repo_root)
    output_path = repo_root / f".worktree-audit-{git_info['head_short']}.json"

    # Allow override via environment variable
    if "WORKTREE_AUDIT_OUTPUT" in os.environ:
        output_path = Path(os.environ["WORKTREE_AUDIT_OUTPUT"]).resolve()

    print(f"Repository: {repo_root}")
    print(f"Branch: {git_info['branch']}")
    print(f"HEAD: {git_info['head']}")
    print(f"Output: {output_path}")

    manifest, digest = collect_manifest(repo_root)
    write_manifest(manifest, output_path)

    print(f"Manifest digest: {digest}")
    print(f"Files processed: {len(manifest['files'])}")
    print(f"Sensitive excluded: {manifest['sensitive_excluded_count']}")
    print(f"Permissions: {oct(output_path.stat().st_mode)[-3:]}")
    print(f"Output written to: {output_path}")


if __name__ == "__main__":
    main()