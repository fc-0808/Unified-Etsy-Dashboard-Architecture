#!/usr/bin/env python3
"""Strangler-fig reducer for generate_shopping_route.py.

Keeps every module-level import/constant and every FUNCTION/CLASS that is
reachable (transitively) from a new slim ``main`` covering only the two live
flows the Unified Dashboard actually invokes:

  1. --import-json ... --reset --no-catalog-update --chinese  -> 5 route files
  2. --build-ready-from <check.xlsx> --output <ready.xlsx>     -> ready report

Everything else (PDF parsing, orders_cache, catalog update/rebuild, HTML,
charm-library management, ~30 unused CLI flags, the 1700-line main) is dropped.

Reachable functions are emitted BYTE-FOR-BYTE from the original source, so the
generated workbooks are identical by construction; verified by compare_xlsx.py.
"""
import ast
import sys
from pathlib import Path

SRC = Path("route-engine/src/generate_shopping_route.py")
OUT = Path("route-engine/src/generate_shopping_route.new.py")

# ── The new slim main + entrypoint (the ONLY hand-written code) ───────────────
SLIM_MAIN = r'''
def _style_comps(style: str) -> frozenset:
    """Style string -> frozenset of component names ({'case','grip','charm'})."""
    hc, hg, hch = _style_has(style)
    return frozenset(x for x, v in (("case", hc), ("grip", hg), ("charm", hch)) if v)


def _line_disc(item: "OrderItem") -> str:
    """Per-line discriminator (Etsy listing id) so two distinct listings that
    share a 50-char title prefix + component set are never collapsed by dedup."""
    return str(getattr(item, "listing_id", "") or "").strip()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Generate Etsy shopping-route Excel files from a Unified "
                    "Dashboard --import-json export (or build the ready-to-ship "
                    "report from an edited checklist)."
    )
    ap.add_argument("--project-dir", default="", metavar="DIR",
                    help="Project root (data/, output/, cache/ subdirs).")
    ap.add_argument("--catalog", default=CATALOG_FILE, help="Supplier catalog .xlsx")
    ap.add_argument("--output", default=OUTPUT_FILE, help="Output .xlsx path")
    ap.add_argument("--threshold", type=int, default=MATCH_THRESHOLD,
                    help="Fuzzy-match score cutoff 0-100 (default %(default)s)")
    ap.add_argument("--import-json", default="", metavar="FILE",
                    help="Unified Dashboard order export to build the route from.")
    ap.add_argument("--build-ready-from", default="", metavar="FILE",
                    help="Build the ready-to-ship report from an edited checklist.")
    ap.add_argument("--exclude-orders-file", default="", metavar="FILE",
                    help="JSON of (title, order) line items to drop from the route.")
    ap.add_argument("--chinese", action="store_true",
                    help="Also write the Simplified Chinese route files (_zh, "
                         "_zh_status, _zh_check).")
    ap.add_argument("--chinese-exclude-shops", default="", metavar="SHOPS",
                    help="Comma-separated Etsy shop names to omit from Chinese files.")
    ap.add_argument("--charm-images-dir", default="", metavar="DIR",
                    help="Directory of <Charm Code>.png charm photos.")
    ap.add_argument("--no-catalog-update", action="store_true",
                    help="Accepted for compatibility; the catalog is never written.")
    ap.add_argument("--reset", action="store_true",
                    help="Accepted for compatibility; the route is always built "
                         "purely from --import-json (no cache merge).")
    ap.add_argument("--no-charm-manifest", action="store_true",
                    help="Skip writing charm_manifest.json.")
    args = ap.parse_args()

    # ── Path resolution (project-dir organized layout) ────────────────────────
    if args.project_dir:
        proj = Path(args.project_dir).resolve()
        catalog_path = proj / "data" / "supplier_catalog.xlsx"
        output_path = (
            Path(args.output).expanduser().resolve()
            if (args.output or "").strip() and args.output != OUTPUT_FILE
            else proj / "output" / "shopping_route.xlsx"
        )
        charm_images_dir = (
            Path(args.charm_images_dir).resolve()
            if args.charm_images_dir.strip()
            else proj / "data" / CHARM_IMAGES_DIR_NAME
        )
    else:
        catalog_path = Path(args.catalog)
        output_path = Path(args.output)
        charm_images_dir = (
            Path(args.charm_images_dir).resolve()
            if args.charm_images_dir.strip()
            else (Path("data") / CHARM_IMAGES_DIR_NAME).resolve()
        )
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.warning("Could not create output directory %s: %s", output_path.parent, exc)
    charm_manifest_default_path = (
        (Path(args.project_dir).resolve() / "data" / CHARM_MANIFEST_FILE)
        if args.project_dir.strip()
        else (catalog_path.parent / CHARM_MANIFEST_FILE)
    ).resolve()

    # ── Flow 2: standalone ready-to-ship report (no catalog / no PDFs) ────────
    if (args.build_ready_from or "").strip():
        src = Path(args.build_ready_from).expanduser().resolve()
        if not src.is_file():
            log.error("Checklist file not found: %s", src)
            sys.exit(1)
        ready_out = (
            Path(args.output).expanduser().resolve()
            if (args.output or "").strip() and args.output != OUTPUT_FILE
            else src.with_name("shopping_route_zh_ready.xlsx")
        )
        try:
            ready_out.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        if ready_out.exists():
            try:
                with open(ready_out, "r+b"):
                    pass
            except PermissionError:
                raise RouteOutputLockedError(
                    f"ROUTE_OUTPUT_LOCKED: {ready_out.name} is open in Excel. "
                    f"Close it and try again."
                )
            except OSError:
                pass
        try:
            n_ready = build_ready_to_ship_from_check(src, ready_out, lang="zh")
        except ValueError as exc:
            log.error("%s", exc)
            sys.exit(1)
        print(f"\n{'=' * 60}")
        print(f"  [READY]  {ready_out.resolve()}")
        print(f"  READY_TO_SHIP_COUNT: {n_ready}")
        print(f"  ({n_ready} order(s) fully purchased - ready to package & ship)")
        print(f"  [source]  {src.name}")
        print(f"{'=' * 60}\n")
        sys.exit(0)

    # ── Flow 1: build the route from the Unified Dashboard JSON export ────────
    import_json_path = (args.import_json or "").strip()
    if not import_json_path:
        ap.error("--import-json is required (or use --build-ready-from).")
    if not catalog_path.exists():
        log.error("Catalog not found: %s", catalog_path)
        sys.exit(1)

    _assert_route_outputs_writable(output_path, want_chinese=bool(args.chinese),
                                   want_html=False)
    try:
        charm_images_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    # Catalog / charm reference data (read from etsy_orders.db when present).
    catalog = load_catalog(catalog_path)
    charm_shops = load_charm_shops(catalog_path)
    charm_library = load_charm_library(catalog_path)

    all_new_orders = import_orders_from_json(Path(import_json_path))
    total_items = sum(len(o.items) for o in all_new_orders)
    log.info("JSON import: %d order(s), %d line item(s) loaded from '%s'",
             len(all_new_orders), total_items, import_json_path)

    new_resolved = match_items(all_new_orders, catalog, args.threshold,
                               db_path=catalog_path.parent / DB_FILE)
    _apply_import_charm_overrides(new_resolved)
    _apply_import_supplier_overrides(new_resolved)

    # Dedup line items. The route is built purely from the import (reset
    # semantics), so we only guard against duplicates within this run. The key
    # includes the listing id so two distinct listings sharing a 50-char title
    # prefix + component set stay separate (never silently dropped).
    _seen_new: set = set()
    all_resolved: list[ResolvedItem] = []
    for _r in new_resolved:
        _k = (_r.order.order_number, _normalize(_r.item.title)[:50],
              _style_comps(_r.item.style), _line_disc(_r.item))
        if _k in _seen_new:
            continue
        _seen_new.add(_k)
        all_resolved.append(_r)
    duplicates = len(new_resolved) - len(all_resolved)
    if duplicates:
        log.info("Skipped %d duplicate line item(s) within this import", duplicates)
    log.info("Total: %d item(s)  [0 from cache + %d new]",
             len(all_resolved), len(all_resolved))
    if not all_resolved:
        log.error("No order items to write.")
        sys.exit(1)

    # Statuses: preserve any from an existing output workbook, then overlay the
    # authoritative Orders-Dashboard UI cache (route_statuses_cache.json).
    existing_statuses = load_existing_statuses(output_path)
    _ui_overrides = _load_ui_status_cache(output_path.parent)
    if _ui_overrides:
        existing_statuses.update(_ui_overrides)
        log.info("Merged %d UI status override(s)", len(_ui_overrides))

    # The dashboard supplies the authoritative listing photo for every line, so
    # catalog photos only FILL IN items that arrived without an image.
    apply_catalog_photos_to_resolved(all_resolved, catalog_path,
                                     fill_missing_only=True)
    apply_canonical_charm_fields_to_resolved(all_resolved, catalog_path)

    # Drop stale charm_agg=Purchased statuses no longer confirmed by every
    # constituent order (keeps the Chinese charm section truthful).
    _stale_agg = []
    for _sk, _sv in existing_statuses.items():
        if not (len(_sk) == 3 and _sk[2] == "charm_agg" and _sv == "Purchased"):
            continue
        _agg_code = _sk[0]
        _agg_orders = [
            r for r in all_resolved
            if _style_has(r.item.style)[2]
            and (r.supplier.charm_code if r.supplier else "").strip() == _agg_code
        ]
        if not _agg_orders:
            continue
        if not all(
            existing_statuses.get(
                (r.order.order_number, _normalize(r.item.title)[:50], "charm")
            ) == "Purchased"
            for r in _agg_orders
        ):
            _stale_agg.append(_sk)
    for _sk in _stale_agg:
        del existing_statuses[_sk]

    # Optional dashboard exclusion list.
    route_resolved = all_resolved
    if (args.exclude_orders_file or "").strip():
        _excl_path = Path(args.exclude_orders_file.strip())
        if _excl_path.is_file():
            try:
                _excl_pairs = _load_dashboard_route_exclusions(_excl_path)
                if _excl_pairs:
                    route_resolved = [
                        r for r in all_resolved
                        if (_normalize(r.item.title),
                            str(r.order.order_number).strip()) not in _excl_pairs
                    ]
                    log.info("Route: %d of %d item(s) included (%d excluded)",
                             len(route_resolved), len(all_resolved),
                             len(all_resolved) - len(route_resolved))
            except Exception as _excl_err:
                log.warning("Could not apply --exclude-orders-file: %s", _excl_err)

    # ── Write the English workbooks (full + simple) ───────────────────────────
    generate_xlsx(route_resolved, output_path, statuses=existing_statuses,
                  charm_shops=charm_shops, charm_library=charm_library,
                  charm_images_dir=charm_images_dir)
    simple_output_path = output_path.with_stem(output_path.stem + "_simple")
    generate_xlsx_simple(route_resolved, simple_output_path,
                         statuses=existing_statuses, charm_shops=charm_shops,
                         charm_library=charm_library,
                         charm_images_dir=charm_images_dir)

    # ── Write the Simplified Chinese workbooks (_zh, _zh_status, _zh_check) ────
    zh_item_count = 0
    if args.chinese:
        excluded_shops = {
            s.strip().lower()
            for s in (args.chinese_exclude_shops or "").split(",") if s.strip()
        }
        zh_items = [r for r in route_resolved
                    if r.order.etsy_shop.lower() not in excluded_shops]
        zh_item_count = len(zh_items)

        zh_path = output_path.with_stem(output_path.stem + "_zh")
        generate_xlsx_simple(zh_items, zh_path, statuses=existing_statuses,
                             charm_shops=charm_shops, charm_library=charm_library,
                             charm_images_dir=charm_images_dir, lang="zh")
        zh_status_path = output_path.with_stem(output_path.stem + "_zh_status")
        generate_xlsx_simple(zh_items, zh_status_path, statuses=existing_statuses,
                             charm_shops=charm_shops, charm_library=charm_library,
                             charm_images_dir=charm_images_dir, lang="zh",
                             show_components=True)
        zh_check_path = output_path.with_stem(output_path.stem + "_zh_check")
        generate_xlsx_status_check(zh_items, zh_check_path,
                                   statuses=existing_statuses,
                                   charm_shops=charm_shops,
                                   charm_library=charm_library,
                                   charm_images_dir=charm_images_dir, lang="zh")

    # ── Charm manifest (consumed by the dashboard charm gallery) ──────────────
    manifest_charm_count = 0
    manifest_written_path = None
    if not args.no_charm_manifest:
        try:
            _route_snap = {
                "order_line_items": len(all_resolved),
                "lines_with_charm_in_order_style": sum(
                    1 for r in all_resolved if _style_has(r.item.style)[2]),
                "matched_lines_with_charm_code": sum(
                    1 for r in all_resolved
                    if r.supplier and (r.supplier.charm_code or "").strip()),
            }
            manifest_charm_count = export_charm_manifest(
                catalog_path, charm_images_dir, charm_manifest_default_path,
                route_snapshot=_route_snap)
            manifest_written_path = charm_manifest_default_path
        except Exception as exc:
            log.warning("Charm manifest (auto) failed: %s", exc)

    # ── Summary ───────────────────────────────────────────────────────────────
    routable_ct = sum(1 for r in route_resolved
                      if r.supplier and (r.supplier.shop_name or r.supplier.stall))
    print(f"\n{'=' * 60}")
    print(f"  [OK]  {routable_ct} item(s) ready  (supplier + location known)")
    print(f"  --->  {output_path.resolve()}  ({len(route_resolved)} items)")
    print(f"  [SIMPLE]  {simple_output_path.resolve()}")
    if manifest_written_path is not None:
        print(f"  [JSON] {manifest_written_path.resolve()}  "
              f"({manifest_charm_count} charm(s))")
    if args.chinese:
        print(f"  [ZH]  {output_path.with_stem(output_path.stem + '_zh').resolve()}"
              f"  ({zh_item_count} items)")
        print(f"  [ZH+STATUS]  "
              f"{output_path.with_stem(output_path.stem + '_zh_status').resolve()}")
        print(f"  [ZH CHECK]   "
              f"{output_path.with_stem(output_path.stem + '_zh_check').resolve()}")
    print(f"{'=' * 60}\n")


if __name__ == "__main__":
    try:
        main()
    except RouteOutputLockedError:
        raise
    except PermissionError as _exc:
        _fname = getattr(_exc, "filename", "") or "a route file"
        _name = Path(_fname).name if _fname else "a route file"
        log.error("Could not write %s - it is open in Excel or another program. "
                  "Close it and run the generation again.", _name)
        raise SystemExit(
            f"ROUTE_OUTPUT_LOCKED: {_name} is open in Excel. "
            f"Close it and click Generate again."
        )
'''


def names_referenced(node: ast.AST) -> set:
    out = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            out.add(n.id)
    return out


def main() -> int:
    source = SRC.read_text(encoding="utf-8")
    lines = source.split("\n")
    tree = ast.parse(source)

    # Index top-level function/class definitions (the prune candidates) and
    # record the names each one references.
    defs = {}            # name -> node
    refs = {}            # name -> set of referenced names
    is_main_guard = []   # If nodes that are `if __name__ == "__main__":`
    keep_other = []      # non-def/class top-level nodes to keep verbatim

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name == "main":
                continue  # replaced by the slim main
            defs[node.name] = node
            refs[node.name] = names_referenced(node)
        elif (isinstance(node, ast.If)
              and isinstance(node.test, ast.Compare)
              and any(isinstance(o, ast.Name) and o.id == "__name__"
                      for o in ast.walk(node.test))):
            is_main_guard.append(node)  # drop the old entrypoint guard
        else:
            keep_other.append(node)

    # Seed roots: names used by the slim main + by every kept module-level stmt.
    roots = names_referenced(ast.parse(SLIM_MAIN))
    for node in keep_other:
        roots |= names_referenced(node)

    # Transitive closure over the def/class graph.
    reachable = set()
    stack = [r for r in roots if r in defs]
    while stack:
        name = stack.pop()
        if name in reachable:
            continue
        reachable.add(name)
        for ref in refs.get(name, ()):
            if ref in defs and ref not in reachable:
                stack.append(ref)

    def seg(node) -> str:
        start = node.lineno
        for d in getattr(node, "decorator_list", []):
            start = min(start, d.lineno)
        return "\n".join(lines[start - 1:node.end_lineno])

    # Emit kept top-level nodes in original order, then the slim main.
    pieces = []
    for node in tree.body:
        if node in is_main_guard:
            continue
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name == "main":
                continue
            if node.name not in reachable:
                continue
        pieces.append(seg(node))

    new_src = "\n".join(pieces).rstrip() + "\n\n" + SLIM_MAIN.strip() + "\n"
    OUT.write_text(new_src, encoding="utf-8")

    pruned = sorted(set(defs) - reachable)
    print(f"defs/classes total : {len(defs)}")
    print(f"  reachable (kept)  : {len(reachable)}")
    print(f"  pruned (dropped)  : {len(pruned)}")
    print(f"original lines      : {len(lines)}")
    print(f"new lines           : {len(new_src.splitlines())}")
    print(f"wrote               : {OUT}")
    print("--- pruned ---")
    print(", ".join(pruned))
    return 0


if __name__ == "__main__":
    sys.exit(main())
