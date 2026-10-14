# Cut out the foreground subject with rembg (u2net). One-shot CLI helper for
# `mascot --file`; the model downloads to ~/.u2net on first run (~176MB).
# Usage: python -P scripts/rembg-cutout.py <in-image> <out.png>
import sys
from rembg import remove
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert("RGBA")
# cap the working size — inference time scales with pixels, and the mascot
# renders at ~57px tall anyway
img.thumbnail((1024, 1024), Image.LANCZOS)
out = remove(img)
out.save(dst)
print("ok", out.size)
