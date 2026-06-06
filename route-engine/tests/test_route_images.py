#!/usr/bin/env python3
"""Regression tests for route-image correctness.

These guard the invariants that keep the generated Shopping Route Excel files
consistent with the Orders Sorting Dashboard.  Run directly::

    python route-engine/tests/test_route_images.py

or under pytest::

    pytest route-engine/tests/test_route_images.py

Invariants under test
---------------------
1.  In the dashboard (``--import-json``) flow, an image supplied with a line
    item is the SINGLE SOURCE OF TRUTH and is never replaced by a catalog
    Product Map photo (``apply_catalog_photos_to_resolved(fill_missing_only=
    True)``).  Items that arrive WITHOUT an image are still filled from the
    catalog.
2.  The PDF flow (``fill_missing_only=False``) still normalises photos by
    overwriting with the catalog photo when available.
3.  The "Orders Detail" sheet shows the PRODUCT photo for every line item —
    never the charm bead image — even when the item includes a charm.
4.  The catalog photo map never exposes an ambiguous 50-char title prefix as a
    lookup key (which would hand one product's photo to a different product).
"""
import io
import os
import sys
import hashlib

import openpyxl

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import generate_shopping_route as g  # noqa: E402


def _png(color):
    """A small, valid, distinct PNG so openpyxl/PIL can embed it."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (3, 3), color).save(buf, "PNG")
    return buf.getvalue()


PRODUCT = _png((255, 0, 0))     # red  — stands in for the listing/product photo
CHARM   = _png((0, 0, 255))     # blue — stands in for the charm bead photo
OTHER   = _png((0, 255, 0))     # green — a catalog photo for a different product


def _h(b):
    return hashlib.md5(b).hexdigest()[:8]


def _make_item(title, style="Case, Grip, Charm", photo=PRODUCT,
               charm_code="CH-00026", shop="鼎基", stall="A203A"):
    order = g.Order(order_number="4072485033", etsy_shop="Y2KiPhoneCases",
                    buyer_name="Rachel Foltz", ship_to_name="Rachel Foltz",
                    ship_to_country="US", order_date="May 25, 2026")
    item = g.OrderItem(title=title, quantity=1, phone_model="iPhone 16 Pro",
                       style=style, photo_bytes=photo)
    supplier = g.CatalogEntry(product_title=title, shop_name=shop, stall=stall,
                              charm_code=charm_code, charm_shop="小艾飾品")
    return g.ResolvedItem(order=order, item=item, supplier=supplier, match_score=99.0)


def test_import_flow_never_overrides_supplied_image(monkeypatch):
    """Invariant 1: a dashboard-supplied image is kept verbatim."""
    title = "Tamagotchi Clear MAGSAFE Case with Tamagotchi Shaker Grip & Beaded Charm"
    # Catalog has a DIFFERENT photo for this exact title — it must be ignored.
    monkeypatch.setattr(g, "get_catalog_photo_map",
                        lambda _p: {g._normalize(title): OTHER})
    r = _make_item(title, photo=PRODUCT)
    n = g.apply_catalog_photos_to_resolved([r], g.Path("ignored"),
                                           fill_missing_only=True)
    assert r.item.photo_bytes == PRODUCT, "supplied image was overridden!"
    assert n == 0


def test_import_flow_fills_missing_image(monkeypatch):
    """Invariant 1: items with no image are still filled from the catalog."""
    title = "Some Product Without A Dashboard Image"
    monkeypatch.setattr(g, "get_catalog_photo_map",
                        lambda _p: {g._normalize(title): OTHER})
    r = _make_item(title, photo=None)
    n = g.apply_catalog_photos_to_resolved([r], g.Path("ignored"),
                                           fill_missing_only=True)
    assert r.item.photo_bytes == OTHER, "missing image was not filled"
    assert n == 1


def test_pdf_flow_still_overrides(monkeypatch):
    """Invariant 2: PDF flow normalises photos to the catalog version."""
    title = "Tamagotchi Clear MAGSAFE Case with Tamagotchi Shaker Grip & Beaded Charm"
    monkeypatch.setattr(g, "get_catalog_photo_map",
                        lambda _p: {g._normalize(title): OTHER})
    r = _make_item(title, photo=PRODUCT)
    g.apply_catalog_photos_to_resolved([r], g.Path("ignored"),
                                       fill_missing_only=False)
    assert r.item.photo_bytes == OTHER, "PDF flow should normalise to catalog photo"


def test_orders_detail_uses_product_photo_not_charm():
    """Invariant 3: the Orders Detail photo column never shows the charm image."""
    title = "Tamagotchi Clear MAGSAFE Case with Tamagotchi Shaker Grip & Beaded Charm"
    r = _make_item(title, photo=PRODUCT)
    charm_lib = {"CH-00026": g.CharmLibraryEntry(code="CH-00026", sku="CH-00026",
                                                 photo_bytes=CHARM)}
    wb = openpyxl.Workbook()
    g._sheet_orders(wb.active, [r], lang="en", charm_library=charm_lib,
                    charm_images_dir=None)
    embedded = {_h(img._data()) for img in wb.active._images}
    assert _h(PRODUCT) in embedded, "product photo missing from Orders Detail"
    assert _h(CHARM) not in embedded, "charm photo leaked into Orders Detail"


def test_catalog_photo_map_drops_ambiguous_prefix():
    """Invariant 4: a 50-char prefix shared by 2 products is not a lookup key."""
    t_a = "Kawaii Monchhichi MagSafe Case with Magnetic Grip Stand, Red Bumper Clear Cover"
    t_b = "Kawaii Monchhichi MagSafe Case with Magnetic Grip & Beaded Charm, Pink Cover"
    t_c = "Tamagotchi Clear MAGSAFE Case with Tamagotchi Shaker Grip & Beaded Charm"
    m = g._build_catalog_photo_map([(t_a, PRODUCT), (t_b, CHARM), (t_c, OTHER)])
    na, nb, nc = g._normalize(t_a), g._normalize(t_b), g._normalize(t_c)
    assert na[:50] == nb[:50], "test setup: prefixes must collide"
    assert m[na] == PRODUCT and m[nb] == CHARM, "exact full-title keys must resolve"
    assert na[:50] not in m, "ambiguous prefix must be dropped"
    assert m.get(nc[:50]) == OTHER, "unambiguous prefix must resolve"


# --- minimal runner so the file works without pytest installed ----------------
class _MonkeyPatch:
    def __init__(self):
        self._undo = []

    def setattr(self, obj, name, value):
        self._undo.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def undo(self):
        for obj, name, old in reversed(self._undo):
            setattr(obj, name, old)
        self._undo.clear()


def _run():
    import inspect
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        mp = _MonkeyPatch()
        try:
            if "monkeypatch" in inspect.signature(fn).parameters:
                fn(mp)
            else:
                fn()
            print(f"  PASS  {name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {name}: {exc}")
        finally:
            mp.undo()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run())
