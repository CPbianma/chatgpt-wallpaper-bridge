# vendor/mascot

Mascot artwork vendored from [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)
(MIT — see `../webwallgl/LICENSE.upstream` for the license text), pinned at
upstream commit `4ba71c4` (WebWallGL 2.1.0 era).

The source PNGs ship with generous transparent margins by design; at runtime
the page alpha-crops to the bounding box and downscales (~256px tall), caching
the derivative on the bridge (`/api/mascot-cache`). `mascot --file <img>`
replaces the mascot with a user image (rembg subject cutout for opaque photos);
those derivatives live in `%LOCALAPPDATA%\ChatGPT-Wallpaper\mascot\`, not here.
