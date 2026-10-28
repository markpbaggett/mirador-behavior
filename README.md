# Mirador behavior for Browsertrix

`mirador-behavior.js` is a Browsertrix Crawler custom behavior for Mirador 3 viewers.

## Run it

Mount the folder and point `--customBehaviors` at the file. Custom behaviors count as
site-specific, so keep `siteSpecific` in `--behaviors` (it is in the default).

```bash
docker run -v $PWD/crawls:/crawls -v $PWD:/behaviors webrecorder/browsertrix-crawler crawl \
  --url "https://example.org/object/123" --scopeType page \
  --customBehaviors /behaviors/mirador-behavior.js \
  --behaviorTimeout 600 --collection mirador-test
```

`--behaviorTimeout` matters: stepping through hundreds of canvases and prefetching
tiles easily exceeds the default.

## What it does

1. Waits for `.mirador-window`.
2. Gets the manifest(s) from Mirador's Redux store (found by scanning `window` globals
   for an object with `.store`), or falls back to manifest URLs the page already requested
   (including a `?manifest=` query param). Fetches every image service's `info.json`.
3. Per window: rewinds with "Previous item", then clicks "Next item" until it is disabled
   (or the canvas stops changing). On each canvas it waits for network quiet, clicks
   "Zoom in" twice, then "Reset zoom".
4. Fetches the low-resolution tile pyramid for every canvas using OpenSeadragon's URL scheme
   (IIIF Image API 1/2/3), capped per canvas.

## Tuning

Edit `opts` at the top of the class: `zoomSteps`, `maxTilesPerCanvas`, `prefetchTiles`,
`prefetchBudgetMs`, `concurrency`, etc.

## Things to check against your viewer

- Button labels: it looks for `button.mirador-next-canvas-button` / aria-label "Next item",
  "Previous item", "Zoom in", "Reset zoom". Mirador plugins and translations can change these.
- If your page doesn't expose the Mirador instance on `window` (e.g. `var miradorInstance = Mirador.viewer(...)`
  inside a module), the store lookup fails and the manifest fallback is used. Check the crawl log for
  `Mirador: store found`.
- Tile URLs assume `info.json`'s `@id`/`id` is what OpenSeadragon requests, jpg tiles, and power-of-two
  scale factors. If replay still misses tiles, compare a requested tile URL in the WARC with the ones
  this generates.
- Gallery/thumbnail-only window views have no Next button; only the current view is captured.
