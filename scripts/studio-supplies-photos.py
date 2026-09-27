#!/usr/bin/env python3
"""Composite every supplies seed photo onto one AI studio plate.

Generative restyles of these SKUs change the printed artwork, so employees
could no longer match the shelf. We keep the original product pixels, cut the
inconsistent table/wall out with rembg, and place the cutout on the same
warm-gray sweep used for Amazon-style catalog tiles.
"""
from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from PIL import Image, ImageFilter
from rembg import new_session, remove

ROOT = Path(__file__).resolve().parents[1]
SEED_DIR = ROOT / "assets" / "supplies-seed"
ORIGINAL_DIR = SEED_DIR / "original"
PLATE_PATH = SEED_DIR / "studio-plate.png"
CANVAS = 1600
FIT = 0.76
ALPHA_KEEP = 12
JPEG_QUALITY = 90


def die(msg: str, code: int = 1) -> None:
	print(f"[studio-supplies] {msg}", file=sys.stderr)
	raise SystemExit(code)


def load_skus() -> list[str]:
	seed = ROOT / "src" / "supplies" / "catalog-seed.js"
	text = seed.read_text(encoding="utf-8")
	skus = []
	for line in text.splitlines():
		if "sku:" not in line:
			continue
		start = line.find("'")
		end = line.find("'", start + 1)
		if start < 0 or end < 0:
			continue
		sku = line[start + 1 : end]
		if sku:
			skus.append(sku)
	if len(skus) < 8:
		die(f"could not parse SKUs from {seed}")
	return skus


def cutout(path: Path, session) -> Image.Image:
	raw = remove(path.read_bytes(), session=session)
	return Image.open(io.BytesIO(as_bytes(raw))).convert("RGBA")


def as_bytes(raw) -> bytes:
	if isinstance(raw, (bytes, bytearray)):
		return bytes(raw)
	if hasattr(raw, "read"):
		return raw.read()
	return bytes(raw)


def trim_alpha(im: Image.Image, threshold: int = ALPHA_KEEP) -> Image.Image:
	alpha = im.split()[-1]
	mask = alpha.point(lambda p: 255 if p > threshold else 0)
	bbox = mask.getbbox()
	if not bbox:
		return im
	pad = 10
	left, top, right, bottom = bbox
	left = max(0, left - pad)
	top = max(0, top - pad)
	right = min(im.width, right + pad)
	bottom = min(im.height, bottom + pad)
	return im.crop((left, top, right, bottom))


def opaque_ratio(im: Image.Image, threshold: int = ALPHA_KEEP) -> float:
	alpha = im.split()[-1]
	hist = alpha.histogram()
	kept = sum(hist[threshold + 1 :])
	return kept / float(max(1, im.width * im.height))


def composite(cut: Image.Image, plate: Image.Image) -> Image.Image:
	canvas = plate.convert("RGB").resize((CANVAS, CANVAS), Image.Resampling.LANCZOS).convert("RGBA")
	product = trim_alpha(cut)
	ratio = opaque_ratio(product)
	if ratio < 0.004:
		# Cutout failed (almost nothing left). Keep the original pixels inset
		# on the plate rather than inventing a new object.
		product = cut.convert("RGBA")
	width, height = product.size
	scale = min((CANVAS * FIT) / max(1, width), (CANVAS * FIT) / max(1, height))
	new_w = max(1, int(round(width * scale)))
	new_h = max(1, int(round(height * scale)))
	product = product.resize((new_w, new_h), Image.Resampling.LANCZOS)
	x = (CANVAS - new_w) // 2
	y = (CANVAS - new_h) // 2

	shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
	alpha = product.split()[-1].point(lambda p: int(p * 0.32))
	blurred = alpha.filter(ImageFilter.GaussianBlur(22))
	blob = Image.new("RGBA", product.size, (0, 0, 0, 0))
	blob.putalpha(blurred)
	shadow.alpha_composite(blob, (x, y + max(10, new_h // 36)))

	out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
	out.alpha_composite(canvas)
	out.alpha_composite(shadow)
	out.alpha_composite(product, (x, y))
	return out.convert("RGB")


def save_jpeg(im: Image.Image, dest: Path) -> None:
	dest.parent.mkdir(parents=True, exist_ok=True)
	im.save(dest, format="JPEG", quality=JPEG_QUALITY, optimize=True, subsampling=0)


def process(only: set[str] | None = None) -> None:
	if not PLATE_PATH.is_file():
		die(f"missing studio plate: {PLATE_PATH}")
	if not ORIGINAL_DIR.is_dir():
		die(f"missing original photos: {ORIGINAL_DIR}")
	plate = Image.open(PLATE_PATH).convert("RGB")
	session = new_session("u2net")
	skus = load_skus()
	done = 0
	for sku in skus:
		if only and sku not in only:
			continue
		src = ORIGINAL_DIR / f"{sku}.jpg"
		if not src.is_file():
			die(f"missing original photo for {sku}: {src}")
		print(f"[studio-supplies] {sku}", flush=True)
		cut = cutout(src, session)
		framed = composite(cut, plate)
		save_jpeg(framed, SEED_DIR / f"{sku}.jpg")
		done += 1
	if done == 0:
		die("no photos processed")
	print(f"[studio-supplies] wrote {done} catalog photos onto {PLATE_PATH.name}")


def main() -> None:
	parser = argparse.ArgumentParser(description="Place supplies seed photos on the shared studio plate")
	parser.add_argument("--only", nargs="*", help="optional SKU filter")
	args = parser.parse_args()
	only = set(args.only) if args.only else None
	process(only)


if __name__ == "__main__":
	main()
