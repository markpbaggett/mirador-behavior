// Browsertrix custom behavior for Mirador 3 viewers.
//
// What it does, in order:
//   1. Waits for .mirador-window elements to render.
//   2. Collects IIIF manifests (from Mirador's Redux store if reachable, otherwise
//      from manifest URLs the page already requested) and fetch()es every
//      image service's info.json so it lands in the WARC.
//   3. For each Mirador window: rewinds to the first canvas, then clicks "Next item"
//      until it is disabled. On every canvas it waits for the network to go quiet,
//      zooms in a few steps (so deeper tile levels are requested), then resets zoom.
//   4. Prefetches the low-resolution tile pyramid (and `sizes`) for every canvas,
//      using the same URL scheme OpenSeadragon uses, so replay works at other
//      window sizes / zoom levels.
//
// Constraints from Browsertrix: one class per file, no exports, no top-level helpers,
// so everything lives on the class.

class MiradorBehavior {
  static id = "Mirador";

  // Mirador is very often embedded in an iframe (Archipelago, Islandora, etc.)
  static runInIframe = true;

  // Browsertrix calls isMatch() from an init script as soon as each frame's document is
  // created, before Mirador has rendered, so the DOM can't be used to decide. The URL can.
  // Add your own pattern here if your viewer lives at a different path.
  static isMatch() {
    const params = new URLSearchParams(location.search);
    return !!(
      /mirador/i.test(location.pathname) ||
      params.has("manifest") ||
      params.has("iiif-content") ||
      window.Mirador ||
      (document.querySelector && document.querySelector(".mirador-viewer, .mirador-window"))
    );
  }

  static init() {
    return { state: { canvases: 0, infoJson: 0, tiles: 0, errors: 0 } };
  }

  // ---- tunables -----------------------------------------------------------
  opts = {
    windowWaitMs: 30000, // how long to wait for the viewer to render
    maxCanvases: 2000, // safety cap per window
    settleQuietMs: 1000, // network must be quiet this long after a click
    settleMaxMs: 10000, // ...but never wait longer than this
    zoomSteps: 2, // "Zoom in" clicks per canvas (0 disables); OSD default is 2x/click
    prefetchInfoJson: true,
    prefetchTiles: true,
    maxTilesPerCanvas: 80, // tile budget per canvas, lowest resolutions first
    concurrency: 6,
    prefetchBudgetMs: 120000, // stop prefetching tiles after this long
  };

  // ---- small utilities ----------------------------------------------------
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  log(ctx, msg) {
    try {
      ctx.log(msg);
    } catch (e) {
      // logging must never break the run
    }
  }

  async waitFor(fn, timeoutMs, intervalMs = 250) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await this.sleep(intervalMs);
    }
    return null;
  }

  // Resolve when no new resource has completed for settleQuietMs.
  async settle() {
    const { settleQuietMs, settleMaxMs } = this.opts;
    const start = Date.now();
    let last = this.resourceCount;
    let lastChange = Date.now();
    while (Date.now() - start < settleMaxMs) {
      await this.sleep(150);
      if (this.resourceCount !== last) {
        last = this.resourceCount;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= settleQuietMs) {
        return;
      }
    }
  }

  watchResources() {
    this.resourceCount = 0;
    try {
      // the default resource timing buffer is only 250 entries, so count via observer
      new PerformanceObserver((list) => {
        this.resourceCount += list.getEntries().length;
      }).observe({ type: "resource" });
    } catch (e) {
      // without the observer, settle() degrades to a fixed quiet wait
    }
  }

  async pool(items, worker, concurrency) {
    let i = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  abs(url) {
    return new URL(url, location.href).href;
  }

  // ---- Mirador DOM helpers --------------------------------------------------
  isDisabled(btn) {
    return (
      btn.disabled ||
      btn.getAttribute("aria-disabled") === "true" ||
      btn.classList.contains("Mui-disabled")
    );
  }

  findButton(win, classSel, labelRe) {
    const byClass = classSel && win.querySelector(classSel);
    if (byClass) return byClass;
    for (const b of win.querySelectorAll("button")) {
      const label = b.getAttribute("aria-label") || b.getAttribute("title") || "";
      if (labelRe.test(label)) return b;
    }
    return null;
  }

  nextButton(win) {
    return this.findButton(win, "button.mirador-next-canvas-button", /^next (item|canvas|page)/i);
  }

  prevButton(win) {
    return this.findButton(
      win,
      "button.mirador-previous-canvas-button",
      /^(previous|prev) (item|canvas|page)/i
    );
  }

  zoomInButton(win) {
    return this.findButton(win, null, /^zoom in/i);
  }

  zoomResetButton(win) {
    return this.findButton(win, null, /^(reset zoom|zoom reset)/i);
  }

  // Something that changes whenever the displayed canvas changes.
  signature(win) {
    if (this.store && win.id) {
      try {
        const w = this.store.getState().windows[win.id];
        if (w && w.canvasId) return w.canvasId;
      } catch (e) {
        // fall through to DOM
      }
    }
    return Array.from(
      win.querySelectorAll(
        "[class*='canvas-count'], [class*='canvas-label'], [class*='osd-info']"
      )
    )
      .map((n) => n.textContent)
      .join("|");
  }

  // ---- IIIF helpers ---------------------------------------------------------
  findStore() {
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (v && v !== window && v.store && typeof v.store.getState === "function") {
          const s = v.store.getState();
          if (s && s.windows && s.manifests) return v.store;
        }
      } catch (e) {
        // some globals throw on access
      }
    }
    return null;
  }

  isManifest(json) {
    if (!json) return false;
    const type = json["@type"] || json.type;
    return type === "sc:Manifest" || type === "Manifest";
  }

  async manifestsFromPage() {
    if (this.store) {
      const found = Object.values(this.store.getState().manifests || {})
        .map((m) => m && m.json)
        .filter((j) => this.isManifest(j));
      if (found.length) return found;
    }

    // No store: look for manifest URLs the page already requested or was given.
    const urls = new Set();
    const params = new URLSearchParams(location.search);
    for (const k of ["manifest", "manifestUrl", "iiif-content"]) {
      if (params.get(k)) urls.add(params.get(k));
    }
    for (const e of performance.getEntriesByType("resource")) {
      if (/manifest/i.test(e.name) && /^(fetch|xmlhttprequest|other)$/.test(e.initiatorType)) {
        urls.add(e.name);
      }
    }
    const manifests = [];
    for (const u of urls) {
      try {
        const json = await (await fetch(this.abs(u))).json();
        if (this.isManifest(json)) manifests.push(json);
      } catch (e) {
        // not JSON / not fetchable; ignore
      }
    }
    return manifests;
  }

  // -> [{ id, width, height }] one entry per canvas that has an image service
  imageServices(manifest) {
    const out = [];
    const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
    const pick = (service) => {
      const svc = asArray(service)[0];
      return svc && (svc["@id"] || svc.id);
    };

    // Presentation 2
    for (const seq of asArray(manifest.sequences)) {
      for (const canvas of asArray(seq.canvases)) {
        for (const img of asArray(canvas.images)) {
          const id = pick(img.resource && img.resource.service);
          if (id) out.push({ id: this.abs(id) });
        }
      }
    }
    // Presentation 3
    for (const canvas of asArray(manifest.items)) {
      for (const page of asArray(canvas.items)) {
        for (const anno of asArray(page.items)) {
          for (const body of asArray(anno.body)) {
            const id = pick(body && body.service);
            if (id) out.push({ id: this.abs(id) });
          }
        }
      }
    }
    return out;
  }

  imageApiVersion(info) {
    const ctx = JSON.stringify(info["@context"] || "");
    if (info.type === "ImageService3" || /image\/3/.test(ctx)) return 3;
    if (/image\/1|1\.1\/context/.test(ctx)) return 1;
    return 2;
  }

  // Mirrors OpenSeadragon's IIIFTileSource.getTileUrl so the URLs match what the
  // viewer will request. Levels are emitted lowest-resolution first and a level is
  // skipped (along with every finer one) once it would blow the tile budget.
  iiifUrls(info, fallbackBase, maxTiles) {
    const base = String(info["@id"] || info.id || fallbackBase).replace(/\/$/, "");
    const version = this.imageApiVersion(info);
    const W = info.width;
    const H = info.height;
    if (!W || !H) return [];
    const quality = (version === 1 ? "native" : "default") + ".jpg";
    const urls = [];

    const sizeParam = (w, h) => {
      if (version === 3) return `${w},${h}`;
      return `${w},`;
    };

    // Mirador also requests a preview from `sizes` even when the service is tiled
    for (const s of info.sizes || []) {
      urls.push(`${base}/full/${sizeParam(s.width, s.height)}/0/${quality}`);
    }

    const tileSpec = Array.isArray(info.tiles) && info.tiles[0];
    if (!tileSpec) {
      return urls.slice(0, maxTiles);
    }

    const tileW = tileSpec.width;
    const tileH = tileSpec.height || tileSpec.width;
    let factors = tileSpec.scaleFactors;
    if (!factors || !factors.length) {
      factors = [1];
      while (Math.max(W, H) / factors[factors.length - 1] > Math.max(tileW, tileH)) {
        factors.push(factors[factors.length - 1] * 2);
      }
    }

    for (const sf of [...factors].sort((a, b) => b - a)) {
      const scale = 1 / sf;
      const levelW = Math.ceil(W * scale);
      const levelH = Math.ceil(H * scale);
      const levelUrls = [];

      if (levelW < tileW && levelH < tileH) {
        let size;
        if (version === 2 && levelW === W) size = "full";
        else if (version === 3 && levelW === W && levelH === H) size = "max";
        else size = sizeParam(levelW, levelH);
        levelUrls.push(`${base}/full/${size}/0/${quality}`);
      } else {
        const regionW = Math.ceil(tileW / scale);
        const regionH = Math.ceil(tileH / scale);
        const nx = Math.ceil(levelW / tileW);
        const ny = Math.ceil(levelH / tileH);
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            const rx = x * regionW;
            const ry = y * regionH;
            const rw = Math.min(regionW, W - rx);
            const rh = Math.min(regionH, H - ry);
            const region = x === 0 && y === 0 && rw === W && rh === H ? "full" : `${rx},${ry},${rw},${rh}`;
            const tw = Math.min(tileW, levelW - x * tileW);
            const th = Math.min(tileH, levelH - y * tileH);
            let size;
            if (version === 2 && tw === W) size = "full";
            else if (version === 3 && tw === W && th === H) size = "max";
            else size = sizeParam(tw, th);
            levelUrls.push(`${base}/${region}/${size}/0/${quality}`);
          }
        }
      }

      if (urls.length + levelUrls.length > maxTiles) break;
      urls.push(...levelUrls);
    }
    return urls;
  }

  async quietFetch(url) {
    try {
      const r = await fetch(url);
      await r.arrayBuffer(); // make sure the body is fully read so it is recorded
      return r;
    } catch (e) {
      return null;
    }
  }

  // ---- phases ---------------------------------------------------------------
  // Phase 2: fetch info.json for every image service. Returns [{ base, info }].
  async loadInfoJsons(ctx, manifests) {
    const bases = new Set();
    for (const m of manifests) {
      for (const s of this.imageServices(m)) bases.add(s.id.replace(/\/$/, ""));
    }
    const infos = [];
    await this.pool(
      [...bases],
      async (base) => {
        const url = `${base}/info.json`;
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          infos.push({ base, info });
          ctx.state.infoJson++;
        } catch (e) {
          ctx.state.errors++;
          this.log(ctx, `Mirador: info.json failed ${url}: ${e && e.message}`);
        }
      },
      this.opts.concurrency
    );
    return infos;
  }

  // Phase 3: click through every canvas of one Mirador window.
  async* walkWindow(ctx, win) {
    const { maxCanvases, zoomSteps } = this.opts;

    this.log(
      ctx,
      `Mirador: window ${win.id || "(no id)"}: next button ${this.nextButton(win) ? "found" : "NOT found"}, ` +
        `prev button ${this.prevButton(win) ? "found" : "NOT found"}, ` +
        `zoom in ${this.zoomInButton(win) ? "found" : "NOT found"}`
    );

    // rewind to the first canvas
    for (let i = 0; i < maxCanvases; i++) {
      const prev = this.prevButton(win);
      if (!prev || this.isDisabled(prev)) break;
      prev.click();
      await this.sleep(80);
    }

    const seen = new Set();
    for (let n = 0; n < maxCanvases; n++) {
      await this.settle();

      const sig = this.signature(win);
      if (sig && seen.has(sig)) break; // Next did not advance
      seen.add(sig);

      for (let z = 0; z < zoomSteps; z++) {
        const zin = this.zoomInButton(win);
        if (!zin) break;
        zin.click();
        await this.sleep(300);
        await this.settle();
      }
      const reset = this.zoomResetButton(win);
      if (reset && zoomSteps > 0) {
        reset.click();
        await this.sleep(200);
      }

      yield ctx.Lib.getState(ctx, `Mirador: visited canvas ${n + 1}`, "canvases");

      const next = this.nextButton(win);
      if (!next || this.isDisabled(next)) break;
      next.click();
      await this.sleep(250);
    }
  }

  // Phase 4: request tiles/sizes the viewer would ask for at other zoom levels.
  async* prefetchTiles(ctx, infos) {
    const { maxTilesPerCanvas, concurrency, prefetchBudgetMs } = this.opts;
    const deadline = Date.now() + prefetchBudgetMs;
    for (const { base, info } of infos) {
      if (Date.now() > deadline) {
        this.log(ctx, "Mirador: tile prefetch budget exhausted");
        return;
      }
      const urls = this.iiifUrls(info, base, maxTilesPerCanvas).filter((u) => {
        if (this.fetched.has(u)) return false;
        this.fetched.add(u);
        return true;
      });
      await this.pool(
        urls,
        async (u) => {
          const r = await this.quietFetch(u);
          if (r && r.ok) ctx.state.tiles++;
          else ctx.state.errors++;
        },
        concurrency
      );
      yield ctx.Lib.getState(ctx, `Mirador: prefetched ${urls.length} tiles for ${base}`);
    }
  }

  // ---- entry point ------------------------------------------------------------
  async* run(ctx) {
    this.fetched = new Set();
    this.watchResources();
    this.store = this.findStore();
    this.log(ctx, `Mirador: store ${this.store ? "found" : "not found, using DOM only"}`);

    const first = await this.waitFor(
      () => document.querySelector(".mirador-window"),
      this.opts.windowWaitMs
    );
    if (!first) {
      this.log(ctx, "Mirador: no .mirador-window appeared, nothing to do");
      return;
    }
    await this.settle();
    yield ctx.Lib.getState(ctx, "Mirador: viewer rendered");

    // manifests -> info.json
    let infos = [];
    if (this.opts.prefetchInfoJson || this.opts.prefetchTiles) {
      const manifests = await this.manifestsFromPage();
      const services = manifests.reduce((n, m) => n + this.imageServices(m).length, 0);
      this.log(ctx, `Mirador: ${manifests.length} manifest(s) found with ${services} image service(s)`);
      infos = await this.loadInfoJsons(ctx, manifests);
      yield ctx.Lib.getState(ctx, `Mirador: fetched ${infos.length} info.json`);
    }

    // click through every window
    const windows = Array.from(document.querySelectorAll(".mirador-window"));
    for (const win of windows) {
      yield* this.walkWindow(ctx, win);
    }

    if (this.opts.prefetchTiles) {
      yield* this.prefetchTiles(ctx, infos);
    }
  }
}
