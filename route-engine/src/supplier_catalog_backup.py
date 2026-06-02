"""
Timestamped backups for supplier_catalog.xlsx.

All automatic copies go under::

    <data-dir>/supplier_catalog_backups/

Filenames look like ``20260414_153045__rebuild_catalog.xlsx`` so they sort
chronologically and stay out of the main data/ clutter.
"""

from __future__ import annotations

import logging
import re
import shutil
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

BACKUP_SUBDIR_NAME = "supplier_catalog_backups"
MAX_BACKUPS_TO_KEEP = 60
_REASON_SAFE = re.compile(r"[^a-zA-Z0-9_-]+")


def catalog_backup_dir(catalog_path: Path) -> Path:
    """Directory where timestamped catalog copies are stored."""
    return catalog_path.parent / BACKUP_SUBDIR_NAME


def _slug_reason(reason: str) -> str:
    s = _REASON_SAFE.sub("_", (reason or "backup").strip().lower()).strip("_")
    return (s[:72] if s else "backup") or "backup"


def _allocate_backup_path(backup_dir: Path, stamp: str, slug: str) -> Path:
    stem = f"{stamp}__{slug}"
    p = backup_dir / f"{stem}.xlsx"
    if not p.exists():
        return p
    n = 2
    while True:
        q = backup_dir / f"{stem}_{n}.xlsx"
        if not q.exists():
            return q
        n += 1


def _prune_old_backups(backup_dir: Path, max_keep: int) -> None:
    if max_keep <= 0:
        return
    files = [p for p in backup_dir.glob("*.xlsx") if p.is_file()]
    if len(files) <= max_keep:
        return
    files.sort(key=lambda p: p.stat().st_mtime)
    for p in files[: len(files) - max_keep]:
        try:
            p.unlink()
            log.info("Removed old catalog backup (retention): %s", p.name)
        except OSError as exc:
            log.warning("Could not remove old backup %s: %s", p, exc)


def backup_supplier_catalog_before_write(
    catalog_path: Path,
    reason: str,
    *,
    max_keep: int = MAX_BACKUPS_TO_KEEP,
) -> Path | None:
    """
    Copy the on-disk catalog to supplier_catalog_backups/ before it is overwritten.

    Returns the path to the new backup file, or None if *catalog_path* does not exist.
    """
    if not catalog_path.is_file():
        return None

    backup_dir = catalog_backup_dir(catalog_path)
    backup_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = _slug_reason(reason)
    dest = _allocate_backup_path(backup_dir, stamp, slug)

    shutil.copy2(catalog_path, dest)
    log.info("Supplier catalog backup (%s) -> %s", reason, dest)

    _prune_old_backups(backup_dir, max_keep)
    return dest


def list_supplier_catalog_backups(
    catalog_path: Path,
    *,
    limit: int = 200,
) -> list[Path]:
    """Newest backups first (by filesystem mtime)."""
    d = catalog_backup_dir(catalog_path)
    if not d.is_dir():
        return []
    files = [p for p in d.glob("*.xlsx") if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:limit]


def restore_supplier_catalog(
    catalog_path: Path,
    backup_file: Path,
    *,
    backup_current_first: bool = True,
) -> None:
    """
    Replace *catalog_path* with the contents of *backup_file*.

    When *backup_current_first* is True, the current catalog (if any) is copied
    into the backup folder as ``before_restore`` before overwriting.
    """
    src = backup_file.resolve()
    if not src.is_file():
        raise FileNotFoundError(f"Backup not found: {backup_file}")

    if backup_current_first:
        backup_supplier_catalog_before_write(catalog_path, "before_restore")

    shutil.copy2(src, catalog_path)
    log.info("Restored supplier catalog from %s -> %s", src, catalog_path)
