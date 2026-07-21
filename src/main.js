import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

"use strict";

(async () => {

    /* Set this to true to bring back the Fabric mod build (fabric-mod/ folder in the
       zip, fabric.mod.json, build.gradle, the works). It's fully wired up below,
       just switched off for now. */
    const INCLUDE_FABRIC_MOD = false;

    /* ---------------- utility ---------------- */
    const $ = (s) => document.querySelector(s);
    const logEl = $("#log"), progWrap = $("#progressWrap"), progBar = $("#progressBar");
    function log(msg, cls) { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = msg; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; }
    function setProgress(pct) { progBar.style.width = Math.max(0, Math.min(100, pct)) + "%"; }
    function slugify(str) {
        return (str || "track").toString().toLowerCase()
            .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
            .replace(/\.[a-z0-9]+$/i, "")
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 48) || "track";
    }
    function uniqueId(base, existing) {
        let id = base, n = 2;
        while (existing.has(id)) { id = base + "_" + n; n++; }
        existing.add(id);
        return id;
    }

    /* Sanitizes a resource-location path (the part after the colon). Keeps
       slashes for nested folders like chests/village/foo but strips anything
       the game won't accept in a namespaced path. */
    function sanitizeResourcePath(p) {
        return (p || "").trim().toLowerCase()
            .replace(/[^a-z0-9/_.-]/g, "_")
            .replace(/\/+/g, "/")
            .replace(/^\/+|\/+$/g, "");
    }
    function sanitizeNamespace(n) {
        return (n || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_") || "minecraft";
    }

    /* Escapes a JS string into a double-quoted SNBT string literal, for use inside a
       /give command's item component brackets: custom_name={text:"..."}. This is not
       JSON.stringify. Commands are parsed as SNBT, not JSON, and the value must not
       be wrapped in an extra pair of quotes or it becomes a literal string instead of
       a parsed text component. */
    function snbtStr(s) {
        return '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }

    /* ---------------- color math ---------------- */
    function relLuminance(r, g, b) {
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0; const l = (max + min) / 2;
        const d = max - min;
        if (d !== 0) {
            s = d / (1 - Math.abs(2 * l - 1));
            switch (max) {
                case r: h = 60 * (((g - b) / d) % 6); break;
                case g: h = 60 * (((b - r) / d) + 2); break;
                case b: h = 60 * (((r - g) / d) + 4); break;
            }
        }
        if (h < 0) h += 360;
        return [h, s, l];
    }
    function hslToRgb(h, s, l) {
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; b = 0 } else if (h < 120) { r = x; g = c; b = 0 }
        else if (h < 180) { r = 0; g = c; b = x } else if (h < 240) { r = 0; g = x; b = c }
        else if (h < 300) { r = x; g = 0; b = c } else { r = c; g = 0; b = x }
        return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }
    function toHex(r, g, b) { return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join(""); }

    /* Extracts two perceptually distinct colors from cover art image data.
       Builds a weighted color histogram (coarse RGB buckets so near-identical pixels
       merge), seeds two cluster centers as the heaviest bucket and the bucket
       farthest from it among the heaviest candidates, then refines both centers with
       a few passes of weighted k-means over the histogram (cheap, since it works on
       bins rather than pixels). This holds up much better than sorting by hue, since
       hue is undefined or noisy for low-saturation pixels. */
    function extractTwoColors(imgData) {
        const data = imgData.data;
        const hist = new Map();
        let totalWeight = 0, blackWeight = 0, whiteWeight = 0;

        for (let i = 0; i < data.length; i += 4 * 2) { // sample every 2nd pixel
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 64) continue;
            const [, s, l] = rgbToHsl(r, g, b);
            const weight = 0.4 + 0.6 * s; // mildly favor saturated pixels without ignoring muted art
            totalWeight += weight;
            if (l < 0.08) blackWeight += weight;
            else if (l > 0.94 && s < 0.10) whiteWeight += weight;

            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4); // 4 bits/channel = 4096 buckets
            let bucket = hist.get(key);
            if (!bucket) { bucket = { r: 0, g: 0, b: 0, w: 0 }; hist.set(key, bucket); }
            bucket.r += r * weight; bucket.g += g * weight; bucket.b += b * weight; bucket.w += weight;
        }

        if (hist.size === 0 || totalWeight === 0) {
            return { main: { r: 194, g: 84, b: 44 }, ring: { r: 56, g: 74, b: 120 } };
        }

        const bins = [...hist.values()]
            .map(b => ({ r: b.r / b.w, g: b.g / b.w, b: b.b / b.w, w: b.w }))
            .sort((a, b) => b.w - a.w);

        const dist3 = (a, b) => Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

        let center1 = { r: bins[0].r, g: bins[0].g, b: bins[0].b };
        let center2 = null, bestDist = -1;
        const pool = bins.slice(0, Math.min(50, bins.length));
        for (const bin of pool) {
            const d = dist3(bin, center1);
            if (d > bestDist) { bestDist = d; center2 = { r: bin.r, g: bin.g, b: bin.b }; }
        }
        if (!center2) center2 = { r: 255 - center1.r, g: 255 - center1.g, b: 255 - center1.b };

        for (let pass = 0; pass < 4; pass++) {
            let s1 = { r: 0, g: 0, b: 0, w: 0 }, s2 = { r: 0, g: 0, b: 0, w: 0 };
            for (const bin of bins) {
                const d1 = dist3(bin, center1), d2 = dist3(bin, center2);
                const t = d1 <= d2 ? s1 : s2;
                t.r += bin.r * bin.w; t.g += bin.g * bin.w; t.b += bin.b * bin.w; t.w += bin.w;
            }
            if (s1.w > 0) center1 = { r: s1.r / s1.w, g: s1.g / s1.w, b: s1.b / s1.w };
            if (s2.w > 0) center2 = { r: s2.r / s2.w, g: s2.g / s2.w, b: s2.b / s2.w };
        }

        let w1 = 0, w2 = 0;
        for (const bin of bins) {
            if (dist3(bin, center1) <= dist3(bin, center2)) w1 += bin.w; else w2 += bin.w;
        }
        let mainColor = w1 >= w2 ? center1 : center2;
        let ringColor = w1 >= w2 ? center2 : center1;

        // Guard against near-black / near-white unless they truly dominate the art
        const dominantAchromatic = (blackWeight + whiteWeight) / totalWeight > 0.55;
        function fixAchromatic(c) {
            const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
            if ((s < 0.12 || l < 0.08 || l > 0.94) && !dominantAchromatic) {
                const hue = isFinite(h) ? h : 30;
                const [r, g, b] = hslToRgb(hue, 0.55, Math.min(Math.max(l, 0.32), 0.62));
                return { r, g, b };
            }
            return c;
        }
        mainColor = fixAchromatic(mainColor);
        ringColor = fixAchromatic(ringColor);

        // Enforce a real minimum separation so the two colors never land near-identical
        if (dist3(mainColor, ringColor) < 70) {
            const [mh, ms, ml] = rgbToHsl(mainColor.r, mainColor.g, mainColor.b);
            const altHue = (mh + 150) % 360;
            const [r, g, b] = hslToRgb(altHue, Math.max(ms, 0.5), ml > 0.5 ? ml - 0.22 : ml + 0.22);
            ringColor = { r, g, b };
        }

        return {
            main: { r: Math.round(mainColor.r), g: Math.round(mainColor.g), b: Math.round(mainColor.b) },
            ring: { r: Math.round(ringColor.r), g: Math.round(ringColor.g), b: Math.round(ringColor.b) }
        };
    }

    /* ---------------- disc template reader ---------------- */
    let TEMPLATE = null; // {w,h,main,ring}

    function loadTemplate() {
        return Promise.all([
            loadImageData("./disc_template_main.png"),
            loadImageData("./disc_template_ring.png")
        ]).then(([main, ring]) => {
            TEMPLATE = { w: main.width, h: main.height, main, ring };
            log("Loaded disc templates", "ok");
        });
    }

    function loadImageData(src) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement("canvas");
                c.width = img.width;
                c.height = img.height;
                const ctx = c.getContext("2d");
                ctx.drawImage(img, 0, 0);
                resolve({
                    width: img.width,
                    height: img.height,
                    data: ctx.getImageData(0, 0, img.width, img.height)
                });
            };
            img.src = src;
        });
    }

    function buildTexture(mainColor, ringColor) {
        const { w, h, main, ring } = TEMPLATE;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        const out = ctx.createImageData(w, h);

        // Alpha is clamped to fully opaque (255) or fully transparent (0), no
        // partial/antialiased edge pixels, so template edges stay crisp instead of
        // blending toward black at low opacity.
        function applyLayer(layer, color) {
            for (let p = 0; p < w * h; p++) {
                const i = p * 4;
                const brightness = layer.data.data[i] / 255;
                const rawAlpha = layer.data.data[i + 3];
                const alpha = rawAlpha > 127 ? 255 : 0;
                if (alpha === 0) continue;
                out.data[i] = color.r * brightness;
                out.data[i + 1] = color.g * brightness;
                out.data[i + 2] = color.b * brightness;
                out.data[i + 3] = Math.max(out.data[i + 3], alpha);
            }
        }

        applyLayer(main, mainColor);
        applyLayer(ring, ringColor);
        ctx.putImageData(out, 0, 0);
        return canvas;
    }

    /* ---------------- metadata ---------------- */
    function readTags(file) {
        return new Promise((resolve) => {
            if (typeof jsmediatags === "undefined") { resolve({}); return; }
            jsmediatags.read(file, {
                onSuccess: (tag) => resolve(tag.tags || {}),
                onError: () => resolve({})
            });
        });
    }

    /* ---------------- state ---------------- */
    const tracks = []; // {id, file, title, artist, cover(dataURL|null), colors, canvas, oggBlob, duration, status}
    const usedIds = new Set(["blank_disc"]); // reserved, never let a track collide with the blank disc's id
    const usedResourceIds = new Set(); // recipe / advancement ids within the project namespace

    const tracksEl = $("#tracks"), emptyMsg = $("#emptyMsg"), genBtn = $("#generateBtn"), genHint = $("#genHint");

    function refreshEmpty() {
        emptyMsg.style.display = tracks.length ? "none" : "block";
        genBtn.disabled = tracks.length === 0;
        genHint.textContent = tracks.length ? tracks.length + " track(s) ready." : "Add at least one track to enable this.";
    }

    async function addFile(file) {
        let track;
        try {
            if (!TEMPLATE) await loadTemplate();
            const id = uniqueId(slugify(file.name), usedIds);
            track = {
                id, file, title: file.name.replace(/\.[a-z0-9]+$/i, ""), artist: "Unknown Artist",
                cover: null, colors: null, canvas: null, oggBlob: null, duration: 180, status: "reading", error: null
            };
            tracks.push(track);
            renderTrack(track);
            refreshEmpty();
        } catch (err) {
            log("Could not add " + file.name + ": " + err.message, "err");
            console.error(err);
            return;
        }

        try {
            const tags = await readTags(file);
            if (tags.title) track.title = tags.title;
            if (tags.artist) track.artist = tags.artist;

            // Prefer an id built from "title_artist" (the tagged metadata) over the
            // filename-derived one assigned above, once we actually have both. The
            // DOM element was already created under the old id, so its id attribute
            // is renamed in place rather than creating a second, orphaned element.
            if (tags.title && tags.artist) {
                const oldEl = document.getElementById("track-" + track.id);
                usedIds.delete(track.id);
                track.id = uniqueId(slugify(track.title + "_" + track.artist), usedIds);
                if (oldEl) oldEl.id = "track-" + track.id;
            }

            let imgData = null;
            if (tags.picture) {
                const { data, format } = tags.picture;
                const bytes = new Uint8Array(data);
                let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                track.cover = `data:${format};base64,${btoa(bin)}`;
                imgData = await coverToImageData(track.cover);
            }
            track.colors = imgData ? extractTwoColors(imgData) : extractTwoColors(fauxImageDataFromString(track.title + track.artist));
            track.canvas = buildTexture(track.colors.main, track.colors.ring);
            track.status = "ready";
        } catch (err) {
            // Metadata/color/texture step failed. The track stays in the list with sane
            // fallbacks so it can still be fixed by hand and the build can continue.
            track.status = "error";
            track.error = err.message;
            track.colors = track.colors || extractTwoColors(fauxImageDataFromString(track.title + track.artist));
            track.canvas = track.canvas || buildTexture(track.colors.main, track.colors.ring);
            log("Problem reading " + file.name + ": " + err.message + " (using fallback title/colors, edit by hand)", "err");
            console.error(err);
        }
        renderTrack(track);
    }

    function fauxImageDataFromString(str) {
        // deterministic pseudo cover so tracks without embedded art still get distinct, stable colors
        const c = document.createElement("canvas"); c.width = 32; c.height = 32;
        const ctx = c.getContext("2d");
        let hash = 0; for (let i = 0; i < str.length; i++) { hash = (hash * 31 + str.charCodeAt(i)) >>> 0; }
        const h1 = hash % 360, h2 = (hash >> 8) % 360;
        const g = ctx.createLinearGradient(0, 0, 32, 32);
        g.addColorStop(0, `hsl(${h1},70%,45%)`);
        g.addColorStop(1, `hsl(${(h2 + 150) % 360},65%,40%)`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
        return ctx.getImageData(0, 0, 32, 32);
    }

    function coverToImageData(dataUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement("canvas");
                const s = 64;
                c.width = s; c.height = s;
                const ctx = c.getContext("2d");
                ctx.drawImage(img, 0, 0, s, s);
                resolve(ctx.getImageData(0, 0, s, s));
            };
            img.onerror = () => resolve(null);
            img.src = dataUrl;
        });
    }

    function renderTrack(t) {
        let el = document.getElementById("track-" + t.id);
        if (!el) {
            el = document.createElement("div");
            el.className = "track";
            el.id = "track-" + t.id;
            tracksEl.appendChild(el);
        }
        const previewCanvas = t.canvas ? t.canvas.toDataURL() : null;
        el.innerHTML = `
    <div class="disc-preview">
      ${previewCanvas ? `<canvas width="16" height="16" style="width:80px;height:80px;image-rendering:pixelated;border-radius:50%;box-shadow:0 6px 18px rgba(0,0,0,.5);" data-src="${previewCanvas}"></canvas>` : `<div style="width:80px;height:80px;border-radius:50%;background:#332c26;display:flex;align-items:center;justify-content:center;font-size:.7rem;color:var(--paper-dim)">...</div>`}
    </div>
    <div class="track-fields">
      <div class="filename">${t.file.name}</div>
      <div class="row">
        <div><label>Title</label><input type="text" data-field="title" value="${t.title.replace(/"/g, '&quot;')}"></div>
        <div><label>Artist</label><input type="text" data-field="artist" value="${t.artist.replace(/"/g, '&quot;')}"></div>
      </div>
      ${t.colors ? `
      <div class="swatches">
        <span class="swatch-label">main</span>
        <div class="swatch" data-color="main" style="background:${toHex(t.colors.main.r, t.colors.main.g, t.colors.main.b)}" title="Click to change"></div>
        <span class="swatch-label">ring</span>
        <div class="swatch" data-color="ring" style="background:${toHex(t.colors.ring.r, t.colors.ring.g, t.colors.ring.b)}" title="Click to change"></div>
      </div>` : `<div class="hint">Extracting colors...</div>`}
    </div>
    <div class="actions">
      <span class="status-chip ${t.status === 'ready' ? 'ok' : t.status === 'error' ? 'err' : 'busy'}">${t.status}</span>
      <button class="btn-remove" data-remove>Remove</button>
    </div>
  `;
        const cnv = el.querySelector("canvas[data-src]");
        if (cnv) {
            const img = new Image();
            img.onload = () => { const ctx = cnv.getContext("2d"); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, 16, 16); };
            img.src = cnv.dataset.src;
        }
        el.querySelector('[data-field="title"]').addEventListener("input", (e) => { t.title = e.target.value; });
        el.querySelector('[data-field="artist"]').addEventListener("input", (e) => { t.artist = e.target.value; });
        el.querySelectorAll('.swatch[data-color]').forEach(sw => {
            sw.addEventListener("click", () => openColorModal(t, sw.dataset.color));
        });
        el.querySelector("[data-remove]").addEventListener("click", () => {
            const idx = tracks.indexOf(t);
            if (idx >= 0) tracks.splice(idx, 1);
            usedIds.delete(t.id);
            el.remove();
            refreshEmpty();
        });
    }
    function hexToRgb(hex) {
        const v = hex.replace("#", "");
        return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
    }
    function isValidHex(hex) { return /^#?[0-9a-fA-F]{6}$/.test(hex); }

    /* ---------------- custom color picker modal ---------------- */
    const colorModal = $("#colorModal");
    const colorModalCanvas = $("#colorModalCanvas");
    const colorModalHex = $("#colorModalHex");
    const colorModalPreview = $("#colorModalPreview");
    const colorModalTitle = $("#colorModalTitle");
    const eyedropperBtn = $("#eyedropperBtn");
    let colorModalTarget = null; // {track, key}

    function updateModalPreview(c) {
        colorModalPreview.style.background = toHex(c.r, c.g, c.b);
    }

    function openColorModal(track, key) {
        colorModalTarget = { track, key };
        colorModalTitle.textContent = (key === "main" ? "Main disc color" : "Ring label color") + " - " + track.title;

        const ctx = colorModalCanvas.getContext("2d");
        ctx.clearRect(0, 0, colorModalCanvas.width, colorModalCanvas.height);
        const artSrc = track.cover || (track.canvas ? track.canvas.toDataURL() : null);
        if (artSrc) {
            const img = new Image();
            img.onload = () => {
                const cw = colorModalCanvas.width, ch = colorModalCanvas.height;
                const scale = Math.max(cw / img.width, ch / img.height);
                const w = img.width * scale, h = img.height * scale;
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
            };
            img.src = artSrc;
        }

        const current = key === "main" ? track.colors.main : track.colors.ring;
        colorModalHex.value = toHex(current.r, current.g, current.b);
        updateModalPreview(current);

        eyedropperBtn.style.display = window.EyeDropper ? "block" : "none";
        colorModal.style.display = "flex";
    }
    function closeColorModal() { colorModal.style.display = "none"; colorModalTarget = null; }

    colorModalCanvas.addEventListener("click", (e) => {
        const rect = colorModalCanvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left) * (colorModalCanvas.width / rect.width));
        const y = Math.floor((e.clientY - rect.top) * (colorModalCanvas.height / rect.height));
        const ctx = colorModalCanvas.getContext("2d");
        try {
            const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
            colorModalHex.value = toHex(r, g, b);
            updateModalPreview({ r, g, b });
        } catch (err) { /* canvas not painted yet */ }
    });

    colorModalHex.addEventListener("input", () => {
        if (isValidHex(colorModalHex.value)) {
            const v = colorModalHex.value.startsWith("#") ? colorModalHex.value : "#" + colorModalHex.value;
            updateModalPreview(hexToRgb(v));
        }
    });

    eyedropperBtn.addEventListener("click", async () => {
        try {
            const result = await new window.EyeDropper().open();
            colorModalHex.value = result.sRGBHex;
            updateModalPreview(hexToRgb(result.sRGBHex));
        } catch (err) { /* user cancelled the eyedropper */ }
    });

    $("#colorModalConfirm").addEventListener("click", () => {
        if (!colorModalTarget) return;
        if (!isValidHex(colorModalHex.value)) {
            colorModalHex.style.borderColor = "var(--err)";
            return;
        }
        colorModalHex.style.borderColor = "";
        const v = colorModalHex.value.startsWith("#") ? colorModalHex.value : "#" + colorModalHex.value;
        const { track, key } = colorModalTarget;
        track.colors[key] = hexToRgb(v);
        track.canvas = buildTexture(track.colors.main, track.colors.ring);
        renderTrack(track);
        closeColorModal();
    });
    $("#colorModalCancel").addEventListener("click", closeColorModal);
    $("#colorModalClose").addEventListener("click", closeColorModal);
    colorModal.addEventListener("click", (e) => { if (e.target === colorModal) closeColorModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && colorModal.style.display === "flex") closeColorModal(); });

    /* ---------------- drag & drop / picker ---------------- */
    const dz = $("#dropzone"), fileInput = $("#fileInput"), fallbackWrap = $("#pickerFallback"), fallbackBtn = $("#fallbackPickBtn");

    function openPicker() {
        try {
            fileInput.click();
        } catch (err) {
            fallbackWrap.style.display = "block";
        }
    }
    dz.addEventListener("click", openPicker);
    fallbackBtn.addEventListener("click", openPicker);

    function handleFileList(fileList) {
        const files = Array.from(fileList);
        if (!files.length) return;
        files.forEach(f => addFile(f).catch(err => log("Failed to add " + f.name + ": " + err.message, "err")));
    }
    fileInput.addEventListener("change", (e) => { handleFileList(e.target.files); fileInput.value = ""; });
    ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => {
        const dropped = [...e.dataTransfer.files].filter(f => f.type.startsWith("audio") || /\.(mp3|wav|flac|m4a|aac|opus|ogg|wma|aiff)$/i.test(f.name));
        handleFileList(dropped);
    });

    /* ---------------- ffmpeg (audio -> ogg vorbis) ---------------- */
    let ffmpegInstance = null;

    async function getFfmpeg() {
        if (ffmpegInstance) return ffmpegInstance;

        const ffmpeg = new FFmpeg();

        ffmpeg.on("log", ({ message }) => {
            console.log(message);
        });

        await ffmpeg.load({
            coreURL: await toBlobURL(
                "/ffmpeg/ffmpeg-core.js",
                "text/javascript"
            ),
            wasmURL: await toBlobURL(
                "/ffmpeg/ffmpeg-core.wasm",
                "application/wasm"
            )
        });

        ffmpegInstance = ffmpeg;
        return ffmpeg;
    }

    async function convertToOgg(track) {
        const ffmpeg = await getFfmpeg();
        const inName = "in_" + track.id;
        const outName = track.id + ".ogg";
        await ffmpeg.writeFile(inName, await fetchFile(track.file));
        await ffmpeg.exec(["-i", inName, "-vn", "-map", "0:a:0", "-c:a", "libvorbis", "-q:a", "6", "-ar", "44100", outName]);
        const data = await ffmpeg.readFile(outName);
        const blob = new Blob([data.buffer], { type: "audio/ogg" });
        await ffmpeg.deleteFile(inName);
        await ffmpeg.deleteFile(outName);
        // duration, decoded from the final ogg so it matches what Minecraft will actually play
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
            track.duration = Math.max(1, Math.round(buf.duration));
            ctx.close();
        } catch (e) { track.duration = 180; }
        return blob;
    }

    /* ---------------- pack assembly ---------------- */

    // Minecraft 26.2 pack formats (see https://minecraft.wiki/w/Pack_format).
    // Since 25w31a pack.mcmeta uses min_format/max_format [major, minor] pairs
    // instead of a single legacy pack_format number.
    const DATA_PACK_FORMAT = [107, 1];
    const RESOURCE_PACK_FORMAT = [88, 0];

    function comparatorFor(durationSeconds) {
        return Math.min(15, Math.max(1, Math.round(durationSeconds / 30)));
    }

    async function canvasToPngBytes(canvas) {
        return new Promise((resolve) => {
            canvas.toBlob(async (blob) => {
                resolve(new Uint8Array(await blob.arrayBuffer()));
            }, "image/png");
        });
    }

    /* The set of item component overrides that make the base disc item into this
       specific custom disc. Shared by the /give command, the stonecutting recipe
       result, and the villager trade sell item, so every way of obtaining a disc
       agrees on what it looks like and sounds like. */
    function discComponents(t, namespace) {
        return {
            item_model: `${namespace}:${t.id}`,
            jukebox_playable: `${namespace}:${t.id}`,
            custom_name: { text: t.title || "Unknown Title" },
            lore: [{ text: t.artist || "Unknown Artist", italic: true, color: "gray" }]
        };
    }

    function autoUnlockAdvancement(namespace, recipeId) {
        // Standard datapack technique: minecraft:recipes/root is an invisible
        // advancement every player has by default (it anchors the recipe book
        // tabs), so granting a child of it via a trigger that fires immediately
        // unlocks the recipe for everyone without any extra criteria.
        return {
            parent: "minecraft:recipes/root",
            criteria: { unlock: { trigger: "minecraft:tick" } },
            rewards: { recipes: [`${namespace}:${recipeId}`] }
        };
    }

    function buildStonecuttingRecipe(ingredientItem, resultItem, components) {
        return {
            type: "minecraft:stonecutting",
            ingredient: ingredientItem,
            result: { id: resultItem, count: 1, components }
        };
    }

    async function generateAll() {
        const namespace = ($("#namespace").value.trim() || "customdiscs").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
        const packName = $("#packname").value.trim() || "Custom Discs";
        const baseDiscItem = "minecraft:music_disc_pigstep";
        if (!tracks.length) return;

        genBtn.disabled = true;
        progWrap.style.display = "block";
        logEl.innerHTML = "";
        setProgress(2);
        log("Starting build for " + tracks.length + " track(s), namespace \"" + namespace + "\"...");
        log(`Targeting Minecraft 26.2, data pack format ${DATA_PACK_FORMAT.join(".")}, resource pack format ${RESOURCE_PACK_FORMAT.join(".")}.`);

        const zip = new JSZip();
        const tldp = zip.folder("datapack");
        const tlrp = zip.folder("resourcepack");
        const dp = tldp.folder(packName);
        const rp = tlrp.folder(packName);
        const geyser = zip.folder("geyser");

        // fabric-mod is only assembled when INCLUDE_FABRIC_MOD is switched on above.
        let tlmod, mod, modResources, modAssetsNs, modItemsDir, modModelsDir, modTexDir, modSoundsDir, modDataRoot, modDataNs, modJukeboxDir;
        if (INCLUDE_FABRIC_MOD) {
            tlmod = zip.folder("fabric-mod");
            mod = tlmod.folder(packName);
        }

        // ---- pack.mcmeta ----
        // Since 25w31a the game uses min_format/max_format [major, minor] pairs
        // rather than a single pack_format integer. Both min and max are pinned
        // to the exact 26.2 formats since that's the only version this pack targets.
        dp.file("pack.mcmeta", JSON.stringify({
            pack: {
                description: packName + " (Datapack)",
                min_format: DATA_PACK_FORMAT,
                max_format: DATA_PACK_FORMAT
            }
        }, null, 2));
        rp.file("pack.mcmeta", JSON.stringify({
            pack: {
                description: packName + " (Resource Pack)",
                min_format: RESOURCE_PACK_FORMAT,
                max_format: RESOURCE_PACK_FORMAT
            }
        }, null, 2));

        const dataRoot = dp.folder("data");
        function dataFolderFor(ns) { return dataRoot.folder(ns); } // JSZip folder() is idempotent per path

        const dpNs = dataFolderFor(namespace);
        const jukeboxDir = dpNs.folder("jukebox_song");
        const fnDir = dpNs.folder("function");
        const recipeDir = dpNs.folder("recipe");
        const advDir = dpNs.folder("advancement").folder("recipes");

        const rpNs = rp.folder("assets").folder(namespace);
        const itemsDir = rpNs.folder("items");
        const modelsDir = rpNs.folder("models").folder("item");
        const texDir = rpNs.folder("textures").folder("item");
        const soundsDir = rpNs.folder("sounds").folder("records");
        const langEntries = {};

        if (INCLUDE_FABRIC_MOD) {
            modResources = mod.folder("src").folder("main").folder("resources");
            modAssetsNs = modResources.folder("assets").folder(namespace);
            modItemsDir = modAssetsNs.folder("items");
            modModelsDir = modAssetsNs.folder("models").folder("item");
            modTexDir = modAssetsNs.folder("textures").folder("item");
            modSoundsDir = modAssetsNs.folder("sounds").folder("records");
            modDataRoot = modResources.folder("data");
            modDataNs = modDataRoot.folder(namespace);
            modJukeboxDir = modDataNs.folder("jukebox_song");
        }

        const geyserMappingsDir = geyser.folder("custom_mappings");
        const geyserRp = geyser.folder("resource_pack");
        const geyserItemTexDir = geyserRp.folder("textures").folder("items");

        const giveLines = [];
        const geyserItems = []; // v2 "definition" entries for the real, playable discs
        const geyserTextureEntries = {}; // item_texture.json texture_data entries
        const soundsJson = {};
        const modSoundsJson = {};

        let i = 0;
        for (const t of tracks) {
            i++;
            log(`[${i}/${tracks.length}] ${t.file.name}: converting to OGG Vorbis...`);
            setProgress(5 + (i - 1) / tracks.length * 55);
            let oggBlob;
            try {
                oggBlob = await convertToOgg(t);
            } catch (e) {
                log("  ffmpeg conversion failed: " + e.message, "err");
                continue;
            }
            const oggBytes = new Uint8Array(await oggBlob.arrayBuffer());
            const pngBytes = await canvasToPngBytes(t.canvas);
            const id = t.id;
            const title = t.title || "Unknown Title";
            const artist = t.artist || "Unknown Artist";
            const soundEventId = `${namespace}:${id}`;
            const langKey = `jukebox_song.${namespace}.${id}`;
            langEntries[langKey] = `${artist} - ${title}`;

            // datapack: jukebox_song
            const jukeboxJson = {
                sound_event: { sound_id: soundEventId },
                description: { translate: langKey },
                length_in_seconds: t.duration,
                comparator_output: comparatorFor(t.duration)
            };
            jukeboxDir.file(id + ".json", JSON.stringify(jukeboxJson, null, 2));
            if (INCLUDE_FABRIC_MOD) modJukeboxDir.file(id + ".json", JSON.stringify(jukeboxJson, null, 2));

            // resourcepack: item model + item definition + texture + sound
            const modelJson = {
                parent: "minecraft:item/generated",
                textures: { layer0: `${namespace}:item/${id}` }
            };
            modelsDir.file(id + ".json", JSON.stringify(modelJson, null, 2));
            if (INCLUDE_FABRIC_MOD) modModelsDir.file(id + ".json", JSON.stringify(modelJson, null, 2));

            const itemDefJson = { model: { type: "minecraft:model", model: `${namespace}:item/${id}` } };
            itemsDir.file(id + ".json", JSON.stringify(itemDefJson, null, 2));
            if (INCLUDE_FABRIC_MOD) modItemsDir.file(id + ".json", JSON.stringify(itemDefJson, null, 2));

            texDir.file(id + ".png", pngBytes);
            if (INCLUDE_FABRIC_MOD) modTexDir.file(id + ".png", pngBytes);

            soundsDir.file(id + ".ogg", oggBytes);
            if (INCLUDE_FABRIC_MOD) modSoundsDir.file(id + ".ogg", oggBytes);
            soundsJson[id] = { sounds: [{ name: `${namespace}:records/${id}`, stream: true }], subtitle: langKey };
            modSoundsJson[id] = { sounds: [`records/${id}`], subtitle: langKey };

            // give command: item components are parsed as SNBT, not JSON. custom_name
            // and lore must be written as bare compound/list literals; wrapping them in
            // an extra pair of quotes (as older 1.20.5-era guides do) turns the whole
            // component into a literal string instead of a parsed text component.
            const nameComp = `{text:${snbtStr(title)}}`;
            const loreComp = `[{text:${snbtStr(artist)},italic:true,color:"gray"}]`;
            giveLines.push(
                `give @s ${baseDiscItem}[item_model="${namespace}:${id}",jukebox_playable="${soundEventId}",custom_name=${nameComp},lore=${loreComp}]`
            );

            // Geyser v2 custom item definition, maps the item_model value above to a
            // Bedrock custom item. Every track always has a stonecutter recipe (below),
            // so creative_category is always "items" so Bedrock's recipe book shows it.
            const bedrockId = `${namespace}:${id}`;
            geyserItems.push({
                type: "definition",
                model: `${namespace}:${id}`,
                bedrock_identifier: bedrockId,
                display_name: `${title} - ${artist}`,
                bedrock_options: { icon: bedrockId, creative_category: "items" }
            });
            geyserTextureEntries[bedrockId] = { textures: [`textures/items/${id}`] };
            geyserItemTexDir.file(id + ".png", pngBytes);

            log(`  done: ${title} - ${artist} (${t.duration}s, comparator ${comparatorFor(t.duration)})`, "ok");
            setProgress(5 + i / tracks.length * 55);
        }

        rpNs.file("sounds.json", JSON.stringify(soundsJson, null, 2));
        if (INCLUDE_FABRIC_MOD) modAssetsNs.file("sounds.json", JSON.stringify(modSoundsJson, null, 2));

        fnDir.file("give_all.mcfunction", giveLines.join("\n") + "\n");
        giveLines.forEach((line, idx) => fnDir.file(`give_${tracks[idx] ? tracks[idx].id : idx}.mcfunction`, line + "\n"));

        // ---- blank disc (Knowledge Book reskin) + librarian trade ----
        setProgress(64);
        log("Building blank disc and librarian trade...");
        const blankId = "blank_disc";
        const blankBaseItem = "minecraft:knowledge_book";

        // White main + white ring: a plain, unlabeled-looking blank. No jukebox_playable
        // at all, this item has no jukebox function of its own, it's purely a
        // stonecutter ingredient.
        const blankCanvas = buildTexture({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 });
        const blankPng = await canvasToPngBytes(blankCanvas);

        const blankModelJson = { parent: "minecraft:item/generated", textures: { layer0: `${namespace}:item/${blankId}` } };
        modelsDir.file(blankId + ".json", JSON.stringify(blankModelJson, null, 2));
        if (INCLUDE_FABRIC_MOD) modModelsDir.file(blankId + ".json", JSON.stringify(blankModelJson, null, 2));
        const blankItemDefJson = { model: { type: "minecraft:model", model: `${namespace}:item/${blankId}` } };
        itemsDir.file(blankId + ".json", JSON.stringify(blankItemDefJson, null, 2));
        if (INCLUDE_FABRIC_MOD) modItemsDir.file(blankId + ".json", JSON.stringify(blankItemDefJson, null, 2));
        texDir.file(blankId + ".png", blankPng);
        if (INCLUDE_FABRIC_MOD) modTexDir.file(blankId + ".png", blankPng);

        const blankComponents = {
            item_model: `${namespace}:${blankId}`,
            custom_name: { text: "Blank Disc" },
            lore: [{ text: "Used in a Stonecutter" }]
        };

        fnDir.file("give_blank_disc.mcfunction",
            `give @s ${blankBaseItem}[item_model="${namespace}:${blankId}",custom_name={text:"Blank Disc"},lore=[{text:"Used in a Stonecutter"}]\n`
        );

        geyserItems.push({
            type: "definition",
            model: `${namespace}:${blankId}`,
            bedrock_identifier: `${namespace}:${blankId}`,
            display_name: "Blank Disc",
            bedrock_options: { icon: `${namespace}:${blankId}`, creative_category: "none" }
        });
        geyserTextureEntries[`${namespace}:${blankId}`] = { textures: [`textures/items/${blankId}`] };
        geyserItemTexDir.file(blankId + ".png", blankPng);

        // Villager trades have no data-pack registry, there's no vanilla file format to
        // declare one. This runs every tick, finds level-5 librarians who haven't been
        // given the trade yet (tracked via a tag so it's only injected once each), and
        // appends it straight to their Offers.Recipes. Entity-held item stacks here still
        // use the pre-1.20.5 "Count" field (capital, alongside the modern "components"
        // map), different from the lowercase "count" used in the recipe JSON below.
        const tradeTag = `${namespace}_blank_trade_added`;
        const tradeOffer = {
            buy: { id: "minecraft:emerald", count: 16 },
            buyB: { id: "minecraft:amethyst_shard", count: 4 },
            sell: { id: blankBaseItem, count: 1, components: blankComponents },
            maxUses: 12,
            uses: 0,
            xp: 5,
            priceMultiplier: 0.05,
            rewardExp: true
        };
        fnDir.file("inject_blank_trade.mcfunction",
            `data modify entity @s Offers.Recipes append value ${JSON.stringify(tradeOffer)}\n` +
            `tag @s add ${tradeTag}\n`
        );
        fnDir.file("add_blank_trade.mcfunction",
            `execute as @e[type=minecraft:villager,nbt={VillagerData:{profession:"minecraft:librarian",level:5}},tag=!${tradeTag}] at @s run function ${namespace}:inject_blank_trade\n`
        );
        // Hooks into the tick tag; merges with other datapacks' tick tags by default
        // (no "replace" key means merge, not overwrite).
        dataFolderFor("minecraft").folder("tags").folder("function").file("tick.json",
            JSON.stringify({ values: [`${namespace}:add_blank_trade`] }, null, 2)
        );
        log("  done: blank disc and level-5 librarian trade (16 emeralds + 4 amethyst shards)", "ok");

        // ---- stonecutting: blank disc -> each custom disc (one-way only) ----
        setProgress(80);
        log(`Writing stonecutting recipes for ${tracks.length} disc(s)...`);
        for (const t of tracks) {
            const comps = discComponents(t, namespace);
            const toId = uniqueId(slugify(t.title) + "_from_blank", usedResourceIds);
            recipeDir.file(toId + ".json", JSON.stringify(buildStonecuttingRecipe(blankBaseItem, baseDiscItem, comps), null, 2));
            advDir.file(toId + ".json", JSON.stringify(autoUnlockAdvancement(namespace, toId), null, 2));
            log(`  done: stonecutter recipe for ${t.title}`, "ok");
        }

        rpNs.folder("lang").file("en_us.json", JSON.stringify(langEntries, null, 2));
        if (INCLUDE_FABRIC_MOD) modAssetsNs.folder("lang").file("en_us.json", JSON.stringify(langEntries, null, 2));

        if (INCLUDE_FABRIC_MOD) {
            const fabricModJson = {
                schemaVersion: 1,
                id: namespace,
                version: "1.0.0",
                name: packName,
                description: `Adds ${tracks.length} custom music disc(s), generated by Disc Press.`,
                authors: [],
                environment: "*",
                license: "CC0-1.0",
                depends: { fabricloader: ">=0.16.0", minecraft: "~26.2", "fabric-resource-loader-v0": "*" }
            };
            modResources.file("fabric.mod.json", JSON.stringify(fabricModJson, null, 2));

            mod.file("build.gradle", buildGradle());
            mod.file("settings.gradle", `pluginManagement {\n  repositories {\n    maven { url 'https://maven.fabricmc.net/' }\n    gradlePluginPortal()\n  }\n}\n`);
            mod.file("gradle.properties", gradleProperties());
            mod.file("README.md", modReadme(namespace));
        }

        // ---- geyser mapping (v2) + minimal Bedrock resource pack for icons ----
        setProgress(90);
        geyserMappingsDir.file(namespace + "_discs.json", JSON.stringify({
            format_version: 2,
            items: {
                [baseDiscItem]: geyserItems.filter(it => it.model !== `${namespace}:${blankId}`),
                [blankBaseItem]: geyserItems.filter(it => it.model === `${namespace}:${blankId}`)
            }
        }, null, 2));

        const rpUuid1 = cryptoRandomUUID(), rpUuid2 = cryptoRandomUUID();
        geyserRp.file("manifest.json", JSON.stringify({
            format_version: 2,
            header: {
                name: packName + " (Bedrock icons)",
                description: "Icons for " + packName + ", used by Geyser to show custom disc textures to Bedrock players.",
                uuid: rpUuid1,
                version: [1, 0, 0],
                min_engine_version: [1, 21, 0]
            },
            modules: [{ type: "resources", uuid: rpUuid2, version: [1, 0, 0] }]
        }, null, 2));
        geyserRp.folder("textures").file("item_texture.json", JSON.stringify({
            resource_pack_name: namespace,
            texture_name: "atlas.items",
            texture_data: geyserTextureEntries
        }, null, 2));
        geyser.file("README.md", geyserReadme(namespace));

        zip.file("README.txt", topReadme(namespace, DATA_PACK_FORMAT, RESOURCE_PACK_FORMAT, baseDiscItem));

        setProgress(95);
        log("Packing zip...");
        const blob = await zip.generateAsync({ type: "blob" }, (meta) => { setProgress(95 + meta.percent / 20); });
        setProgress(100);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = namespace + "_disc_pack.zip";
        document.body.appendChild(a); a.click(); a.remove();
        log("Done, download started: " + namespace + "_disc_pack.zip", "ok");
        genBtn.disabled = false;
    }

    function cryptoRandomUUID() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        // Fallback for browsers without crypto.randomUUID (rare, but there's no
        // backend here to generate this instead).
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /* The functions below build the Fabric mod project. They're kept around so the
       mod option is a flag flip away, but nothing calls them while
       INCLUDE_FABRIC_MOD is false. */
    function buildGradle() {
        return `plugins {
\tid 'fabric-loom' version '1.7-SNAPSHOT'
\tid 'maven-publish'
}

version = project.mod_version
group = project.maven_group

repositories {
\tmavenCentral()
}

dependencies {
\t// Check https://fabricmc.net/develop for the exact strings that match Minecraft 26.2
\tminecraft "com.mojang:minecraft:\${project.minecraft_version}"
\tmappings "net.fabricmc:yarn:\${project.yarn_mappings}:v2"
\tmodImplementation "net.fabricmc:fabric-loader:\${project.loader_version}"
\tmodImplementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_version}"
}

java {
\twithSourcesJar()
\tsourceCompatibility = JavaVersion.VERSION_21
\ttargetCompatibility = JavaVersion.VERSION_21
}

processResources {
\tinputs.property "version", project.version
\tfilteringCharset "UTF-8"
\tfilesMatching("fabric.mod.json") {
\t\texpand "version": project.version
\t}
}
`;
    }
    function gradleProperties() {
        return `# Fill these in from https://fabricmc.net/develop for Minecraft 26.2,
# they change often and are deliberately left as placeholders here.
minecraft_version=26.2
yarn_mappings=26.2+build.1
loader_version=0.16.9
fabric_version=0.100.0+26.2
mod_version=1.0.0
maven_group=com.discpress
`;
    }
    function modReadme(namespace) {
        return `# ${namespace} - Fabric music disc mod

This is a plain resource and data bundle wrapped as a Fabric mod jar. There is
no Java code: item textures/models, sound events, jukebox_song entries,
the blank-disc stonecutting recipes, and the trade-injection function under
src/main/resources are picked up automatically by Minecraft the same way a
resource pack and datapack would be, because mod jars are merged into both
the resource and data systems.

## Building

1. Open gradle.properties and fill in the real yarn_mappings, loader_version
   and fabric_version for Minecraft 26.2 from https://fabricmc.net/develop,
   these are placeholders and change often, so they are not baked in.
2. From this folder, run:
       ./gradlew build          (Linux/macOS)
       gradlew.bat build        (Windows)
3. The built jar appears in build/libs/. Drop it into your .minecraft/mods
   folder alongside Fabric Loader + Fabric API for 26.2.

Building happens entirely on your machine, nothing here is pre-built.
`;
    }
    function geyserReadme(namespace) {
        return `Geyser custom item mapping (v2)
================================

custom_mappings/${namespace}_discs.json uses Geyser's current v2 custom item
format (format_version 2, "type": "definition" entries keyed by Java item and
matched against the item's minecraft:item_model component). The old v1
format (a flat map of custom_model_data numbers) is deprecated and is not
what this pack generates.

There are two groups of entries: the real, playable discs (keyed under
whichever vanilla disc item the pack uses) and the blank disc (keyed under
minecraft:knowledge_book).

Setup:
1. Copy custom_mappings/${namespace}_discs.json into Geyser's own
   custom_mappings/ folder (created next to Geyser's jar/data folder after
   its first run).
2. Copy the contents of resource_pack/ into a Bedrock resource pack folder
   (or zip it) and drop it into Geyser's packs/ folder. It only contains a
   manifest and per-disc icon textures pulled from the generated disc art,
   Geyser needs this to show the right icon in Bedrock inventories; it does
   not affect Java players at all.
3. Make sure gameplay.enable-custom-content: true is set in Geyser's config.
4. Restart the server.

Every real disc always has a matching stonecutter recipe, so its
creative_category is always "items" (so it shows up in Bedrock's recipe
book). The blank disc has no recipe producing it (it only comes from the
librarian trade), so its creative_category is "none".
`;
    }
    function topReadme(namespace, dataFmt, rpFmt, baseDiscItem) {
        return `Disc Press output
==================

Target version: Minecraft 26.2
  data pack format:     ${dataFmt.join(".")}
  resource pack format: ${rpFmt.join(".")}

Both pack.mcmeta files use the current min_format/max_format pair format
(replacing the old single "pack_format" number since 25w31a), pinned to
exactly the 26.2 formats above.

Contents
--------
datapack/       drop the folder inside this directory into a world's
                 .minecraft/saves/<world>/datapacks/${namespace}/ folder,
                 or zip it and use as a datapack. Includes jukebox songs,
                 give functions, the blank-disc trade-injection function,
                 and the stonecutting recipes/advancements.
resourcepack/    same idea, the folder inside goes in .minecraft/resourcepacks/, or zip it.
geyser/          Geyser v2 custom item mappings plus a minimal Bedrock
                 resource pack with disc icon textures. See geyser/README.md.

Getting discs in-game
----------------------
Every real disc is built on top of ${baseDiscItem}, its name, texture,
model and sound are swapped via item components, but the underlying item
stays that one vanilla disc. Each track's own function is at
datapack/data/${namespace}/function/give_<id>.mcfunction, and give_all.mcfunction
runs every one of them at once. /give commands use the current item-component
SNBT syntax (custom_name={text:"..."}), not the pre-1.21.5 JSON-string style.

Blank disc and the stonecutter
-------------------------------
Trade 16 emeralds + 4 amethyst shards with a level 5 (master) librarian for a
blank disc. Vanilla has no data-pack registry for villager trades, so this is
done with a function (data/${namespace}/function/add_blank_trade.mcfunction,
hooked into the #minecraft:tick function tag) that finds level-5 librarians
who haven't received the trade yet and injects it directly into their
Offers.Recipes, tagging them afterward so it's only added once per villager.

The blank disc itself is a reskinned minecraft:knowledge_book, an all-white
label, deliberately given no jukebox_playable component, so it has no
function of its own beyond being a stonecutter ingredient. Put it in a
stonecutter to turn it into any of your custom discs
(data/${namespace}/recipe/<id>_from_blank.json). There is intentionally no
disc-to-blank conversion.

Knowledge books have no natural source in survival and aren't offered in the
creative menu, so nothing else a player might be holding can trigger these
stonecutting recipes by accident, and the real, playable discs never have to
serve double duty as a stonecutter ingredient.

Notes on 26.2
-------------
26.2 uses the new item-component system throughout: item_model,
jukebox_playable, custom_name, lore and recipe results with "components"
are all set via item components rather than legacy NBT tags. Commands (like
the /give lines above) are parsed as SNBT, which is why component values use
unquoted compound keys, e.g. {text:"..."}, wrapping a whole component in an
extra pair of quotes (valid in some pre-1.21.5 tutorials) turns it into a
literal string instead of a parsed component and silently breaks the name/lore.
`;
    }

    genBtn.addEventListener("click", generateAll);

    /* preload template as soon as possible */
    loadTemplate();
    refreshEmpty();
})();
