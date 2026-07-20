import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

"use strict";

(async () => {

/* ---------------- utility ---------------- */
const $ = (s) => document.querySelector(s);
const logEl = $("#log"), progWrap = $("#progressWrap"), progBar = $("#progressBar");
function log(msg, cls){ const d=document.createElement("div"); if(cls) d.className=cls; d.textContent=msg; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; }
function setProgress(pct){ progBar.style.width = Math.max(0,Math.min(100,pct))+"%"; }
function slugify(str){
  return (str||"track").toString().toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\.[a-z0-9]+$/i,"")
    .replace(/[^a-z0-9]+/g,"_")
    .replace(/^_+|_+$/g,"")
    .slice(0,48) || "track";
}
function uniqueId(base, existing){
  let id = base, n = 2;
  while(existing.has(id)){ id = base+"_"+n; n++; }
  existing.add(id);
  return id;
}
function escapeJson(str){ return JSON.stringify(str).slice(1,-1); }

/* ---------------- color math ---------------- */
function relLuminance(r,g,b){
  return (0.2126*r + 0.7152*g + 0.0722*b) / 255;
}
function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h=0,s=0; const l=(max+min)/2;
  const d=max-min;
  if(d!==0){
    s = d/(1-Math.abs(2*l-1));
    switch(max){
      case r: h = 60*(((g-b)/d)%6); break;
      case g: h = 60*(((b-r)/d)+2); break;
      case b: h = 60*(((r-g)/d)+4); break;
    }
  }
  if(h<0) h+=360;
  return [h,s,l];
}
function hslToRgb(h,s,l){
  const c=(1-Math.abs(2*l-1))*s;
  const x=c*(1-Math.abs((h/60)%2-1));
  const m=l-c/2;
  let r=0,g=0,b=0;
  if(h<60){r=c;g=x;b=0} else if(h<120){r=x;g=c;b=0}
  else if(h<180){r=0;g=c;b=x} else if(h<240){r=0;g=x;b=c}
  else if(h<300){r=x;g=0;b=c} else {r=c;g=0;b=x}
  return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
}
function colorDist(c1,c2){
  const dr=c1[0]-c2[0], dg=c1[1]-c2[1], db=c1[2]-c2[2];
  return Math.sqrt(dr*dr+dg*dg+db*db);
}
function hueDist(a,b){
  const d = Math.abs(a-b)%360;
  return d>180 ? 360-d : d;
}
function toHex(r,g,b){ return "#"+[r,g,b].map(v=>v.toString(16).padStart(2,"0")).join(""); }

/* Extract two perceptually distinct colors from cover-art image data */
function extractTwoColors(imgData){
  const data = imgData.data;
  const HUE_BUCKETS = 36; // 10 deg each
  const vivid = new Array(HUE_BUCKETS).fill(0).map(()=>({weight:0,sSum:0,lSum:0,n:0}));
  const all = new Array(HUE_BUCKETS).fill(0).map(()=>({weight:0,sSum:0,lSum:0,n:0}));
  let vividTotal=0, allTotal=0;
  let blackWeight=0, whiteWeight=0, totalWeight=0;

  for(let i=0;i<data.length;i+=4*3){ // sample every 3rd pixel for speed
    const r=data[i], g=data[i+1], b=data[i+2], a=data[i+3];
    if(a<64) continue;
    const [h,s,l] = rgbToHsl(r,g,b);
    const bucket = Math.floor(h/10)%HUE_BUCKETS;
    const w = 1;
    totalWeight += w;
    all[bucket].weight += w; all[bucket].sSum += s; all[bucket].lSum += l; all[bucket].n++;
    allTotal += w;
    const isVivid = s > 0.16 && l > 0.10 && l < 0.90;
    if(isVivid){
      vivid[bucket].weight += w; vivid[bucket].sSum += s; vivid[bucket].lSum += l; vivid[bucket].n++;
      vividTotal += w;
    }
    if(l < 0.10) blackWeight += w;
    if(l > 0.92 && s < 0.12) whiteWeight += w;
  }

  function bucketColor(b){
    const bucket = vivid[b].n ? vivid[b] : all[b];
    const h = b*10+5;
    const s = bucket.n ? bucket.sSum/bucket.n : 0.6;
    const l = bucket.n ? bucket.lSum/bucket.n : 0.5;
    return {h, s: Math.max(s,0.45), l: Math.min(Math.max(l,0.28),0.72)};
  }

  const useSet = (vividTotal / Math.max(allTotal,1)) > 0.04 ? vivid : null;

  let mainIdx = -1, mainWeight = -1;
  const source = useSet || all;
  for(let i=0;i<HUE_BUCKETS;i++){
    if(source[i].weight > mainWeight){ mainWeight = source[i].weight; mainIdx = i; }
  }

  let ringIdx = -1, ringWeight = -1;
  for(let i=0;i<HUE_BUCKETS;i++){
    if(i===mainIdx) continue;
    if(hueDist(i*10+5, mainIdx*10+5) < 40) continue;
    if(source[i].weight > ringWeight){ ringWeight = source[i].weight; ringIdx = i; }
  }
  // relax the angular constraint if nothing qualified
  if(ringIdx === -1){
    for(let i=0;i<HUE_BUCKETS;i++){
      if(i===mainIdx) continue;
      if(source[i].weight > ringWeight){ ringWeight = source[i].weight; ringIdx = i; }
    }
  }

  let mainColor, ringColor;
  if(mainIdx === -1 || vividTotal===0 && whiteWeight+blackWeight < totalWeight*0.55){
    // no usable signal at all — safe fallback (a warm amber / deep plum, never used blindly if art exists)
    mainColor = {r:194,g:84,b:44};
    ringColor = {r:56,g:74,b:120};
  } else {
    const mc = bucketColor(mainIdx);
    const rc = ringIdx===-1 ? {h:(mc.h+150)%360, s:0.5, l:0.45} : bucketColor(ringIdx);
    const [mr,mg,mb] = hslToRgb(mc.h, mc.s, mc.l);
    const [rr,rg,rb] = hslToRgb(rc.h, rc.s, rc.l);
    mainColor = {r:mr,g:mg,b:mb};
    ringColor = {r:rr,g:rg,b:rb};
  }

  // Guard against near-black / near-white choices unless they truly dominate the art
  const dominantAchromatic = (blackWeight+whiteWeight) / Math.max(totalWeight,1) > 0.55;
  function isAchromatic(c){ const [,s,l]=rgbToHsl(c.r,c.g,c.b); return s<0.12 || l<0.08 || l>0.94; }
  if(isAchromatic(mainColor) && !dominantAchromatic){ mainColor = {r:194,g:84,b:44}; }
  if(isAchromatic(ringColor) && !dominantAchromatic){ ringColor = {r:226,g:165,b:58}; }
  if(colorDist([mainColor.r,mainColor.g,mainColor.b],[ringColor.r,ringColor.g,ringColor.b]) < 60){
    ringColor = {r:226,g:165,b:58};
  }

  return {main:mainColor, ring:ringColor};
}

/* ---------------- disc template reader ---------------- */
let TEMPLATE = null; // {w,h,group:[],lumDelta:[],alpha:[]}
const REF_RED = [255,0,0];
const REF_YELLOW = [255,255,0];

function loadTemplate(){
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img,0,0);
      const data = ctx.getImageData(0,0,c.width,c.height);
      const n = c.width*c.height;
      const group = new Uint8Array(n);
      const lumDelta = new Float32Array(n);
      const alpha = new Uint8Array(n);
      const lumRed = relLuminance(...REF_RED);
      const lumYellow = relLuminance(...REF_YELLOW);
      for(let p=0;p<n;p++){
        const i = p*4;
        const r=data.data[i], g=data.data[i+1], b=data.data[i+2], a=data.data[i+3];
        const dRed = colorDist([r,g,b], REF_RED);
        const dYellow = colorDist([r,g,b], REF_YELLOW);
        const g0 = dRed <= dYellow ? 0 : 1;
        group[p] = g0;
        const lum = relLuminance(r,g,b);
        lumDelta[p] = lum - (g0===0 ? lumRed : lumYellow);
        alpha[p] = a;
      }
      TEMPLATE = {w:c.width, h:c.height, group, lumDelta, alpha};
      log("Loaded disc_template.png ("+c.width+"×"+c.height+") — pixel arrays built.", "ok");
      resolve(true);
    };
    img.onerror = () => {
      log("Could not load ./disc_template.png — place it next to this HTML file. Using a generated placeholder ring instead.", "err");
      // synth a minimal placeholder template: filled disc (red) with a ring band (yellow), circular alpha mask
      const w=16,h=16;
      const group = new Uint8Array(w*h), lumDelta = new Float32Array(w*h), alpha = new Uint8Array(w*h);
      const cx=7.5, cy=7.5, R=7.5;
      for(let y=0;y<h;y++) for(let x=0;x<w;x++){
        const p=y*w+x;
        const d = Math.sqrt((x-cx)**2+(y-cy)**2);
        alpha[p] = d<=R ? 255 : 0;
        const ring = d>2.3 && d<3.4;
        group[p] = ring ? 1 : 0;
        lumDelta[p] = ((x+y)%3===0) ? 0.06 : ((x*y)%7===0 ? -0.08 : 0);
      }
      TEMPLATE = {w,h,group,lumDelta,alpha};
      resolve(false);
    };
    img.src = "./disc_template.png";
  });
}

function buildTexture(mainColor, ringColor){
  const {w,h,group,lumDelta,alpha} = TEMPLATE;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(w,h);
  const mainHsl = rgbToHsl(mainColor.r,mainColor.g,mainColor.b);
  const ringHsl = rgbToHsl(ringColor.r,ringColor.g,ringColor.b);
  for(let p=0;p<w*h;p++){
    const useRing = group[p]===1;
    const [bh,bs,bl] = useRing ? ringHsl : mainHsl;
    const newL = Math.min(1,Math.max(0, bl + lumDelta[p]));
    const [r,g,b] = hslToRgb(bh,bs,newL);
    const i=p*4;
    out.data[i]=r; out.data[i+1]=g; out.data[i+2]=b; out.data[i+3]=alpha[p];
  }
  ctx.putImageData(out,0,0);
  return canvas;
}

/* ---------------- metadata ---------------- */
function readTags(file){
  return new Promise((resolve) => {
    if(typeof jsmediatags === "undefined"){ resolve({}); return; }
    jsmediatags.read(file, {
      onSuccess: (tag) => resolve(tag.tags || {}),
      onError: () => resolve({})
    });
  });
}

/* ---------------- state ---------------- */
const tracks = []; // {id, file, title, artist, cover(dataURL|null), colors, canvas, oggBlob, duration, status}
const usedIds = new Set();

const tracksEl = $("#tracks"), emptyMsg = $("#emptyMsg"), genBtn = $("#generateBtn"), genHint = $("#genHint");

function refreshEmpty(){
  emptyMsg.style.display = tracks.length ? "none" : "block";
  genBtn.disabled = tracks.length === 0;
  genHint.textContent = tracks.length ? tracks.length+" track(s) ready." : "Add at least one track to enable this.";
}

async function addFile(file){
  if(!TEMPLATE) await loadTemplate();
  const id = uniqueId(slugify(file.name), usedIds);
  const track = { id, file, title: file.name.replace(/\.[a-z0-9]+$/i,""), artist:"Unknown Artist",
    cover:null, colors:null, canvas:null, oggBlob:null, duration:180, status:"reading" };
  tracks.push(track);
  renderTrack(track);
  refreshEmpty();

  const tags = await readTags(file);
  if(tags.title) track.title = tags.title;
  if(tags.artist) track.artist = tags.artist;

  let imgData = null;
  if(tags.picture){
    const {data, format} = tags.picture;
    const bytes = new Uint8Array(data);
    let bin = ""; for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    track.cover = `data:${format};base64,${btoa(bin)}`;
    imgData = await coverToImageData(track.cover);
  }
  track.colors = imgData ? extractTwoColors(imgData) : extractTwoColors(fauxImageDataFromString(track.title+track.artist));
  track.canvas = buildTexture(track.colors.main, track.colors.ring);
  track.status = "ready";
  renderTrack(track);
}

function fauxImageDataFromString(str){
  // deterministic pseudo cover so tracks without embedded art still get distinct, stable colors
  const c=document.createElement("canvas"); c.width=32; c.height=32;
  const ctx=c.getContext("2d");
  let hash=0; for(let i=0;i<str.length;i++){ hash = (hash*31 + str.charCodeAt(i)) >>> 0; }
  const h1 = hash%360, h2=(hash>>8)%360;
  const g = ctx.createLinearGradient(0,0,32,32);
  g.addColorStop(0, `hsl(${h1},70%,45%)`);
  g.addColorStop(1, `hsl(${(h2+150)%360},65%,40%)`);
  ctx.fillStyle=g; ctx.fillRect(0,0,32,32);
  return ctx.getImageData(0,0,32,32);
}

function coverToImageData(dataUrl){
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const s = 64;
      c.width=s; c.height=s;
      const ctx = c.getContext("2d");
      ctx.drawImage(img,0,0,s,s);
      resolve(ctx.getImageData(0,0,s,s));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function renderTrack(t){
  let el = document.getElementById("track-"+t.id);
  if(!el){
    el = document.createElement("div");
    el.className = "track";
    el.id = "track-"+t.id;
    tracksEl.appendChild(el);
  }
  const previewCanvas = t.canvas ? t.canvas.toDataURL() : null;
  el.innerHTML = `
    <div class="disc-preview">
      ${previewCanvas ? `<canvas width="16" height="16" style="width:80px;height:80px;image-rendering:pixelated;border-radius:50%;box-shadow:0 6px 18px rgba(0,0,0,.5);" data-src="${previewCanvas}"></canvas>` : `<div style="width:80px;height:80px;border-radius:50%;background:#332c26;display:flex;align-items:center;justify-content:center;font-size:.7rem;color:var(--paper-dim)">…</div>`}
    </div>
    <div class="track-fields">
      <div class="filename">${t.file.name}</div>
      <div class="row">
        <div><label>Title</label><input type="text" data-field="title" value="${t.title.replace(/"/g,'&quot;')}"></div>
        <div><label>Artist</label><input type="text" data-field="artist" value="${t.artist.replace(/"/g,'&quot;')}"></div>
      </div>
      ${t.colors ? `
      <div class="swatches">
        <span class="swatch-label">main</span>
        <input type="color" data-color="main" value="${toHex(t.colors.main.r,t.colors.main.g,t.colors.main.b)}">
        <span class="swatch-label">ring</span>
        <input type="color" data-color="ring" value="${toHex(t.colors.ring.r,t.colors.ring.g,t.colors.ring.b)}">
      </div>` : `<div class="hint">Extracting colors…</div>`}
    </div>
    <div class="actions">
      <span class="status-chip ${t.status==='ready'?'ok':t.status==='error'?'err':'busy'}">${t.status}</span>
      <button class="btn-remove" data-remove>Remove</button>
    </div>
  `;
  const cnv = el.querySelector("canvas[data-src]");
  if(cnv){
    const img = new Image();
    img.onload = () => { const ctx = cnv.getContext("2d"); ctx.imageSmoothingEnabled=false; ctx.drawImage(img,0,0,16,16); };
    img.src = cnv.dataset.src;
  }
  el.querySelector('[data-field="title"]').addEventListener("input", (e)=>{ t.title = e.target.value; });
  el.querySelector('[data-field="artist"]').addEventListener("input", (e)=>{ t.artist = e.target.value; });
  const mainPicker = el.querySelector('[data-color="main"]');
  const ringPicker = el.querySelector('[data-color="ring"]');
  if(mainPicker) mainPicker.addEventListener("input", (e)=>{
    const hex = e.target.value; t.colors.main = hexToRgb(hex);
    t.canvas = buildTexture(t.colors.main, t.colors.ring); renderTrack(t);
  });
  if(ringPicker) ringPicker.addEventListener("input", (e)=>{
    const hex = e.target.value; t.colors.ring = hexToRgb(hex);
    t.canvas = buildTexture(t.colors.main, t.colors.ring); renderTrack(t);
  });
  el.querySelector("[data-remove]").addEventListener("click", ()=>{
    const idx = tracks.indexOf(t);
    if(idx>=0) tracks.splice(idx,1);
    usedIds.delete(t.id);
    el.remove();
    refreshEmpty();
  });
}
function hexToRgb(hex){
  const v = hex.replace("#","");
  return {r:parseInt(v.slice(0,2),16), g:parseInt(v.slice(2,4),16), b:parseInt(v.slice(4,6),16)};
}

/* ---------------- drag & drop / picker ---------------- */
const dz = $("#dropzone"), fileInput = $("#fileInput");
dz.addEventListener("click", ()=>fileInput.click());
fileInput.addEventListener("change", (e)=>{ [...e.target.files].forEach(addFile); fileInput.value=""; });
["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,(e)=>{e.preventDefault();dz.classList.add("drag");}));
["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,(e)=>{e.preventDefault();dz.classList.remove("drag");}));
dz.addEventListener("drop",(e)=>{ [...e.dataTransfer.files].filter(f=>f.type.startsWith("audio")||/\.(mp3|wav|flac|m4a|aac|opus|ogg|wma|aiff)$/i.test(f.name)).forEach(addFile); });

/* ---------------- ffmpeg (audio -> ogg vorbis) ---------------- */
let ffmpegInstance = null;
async function getFfmpeg(){
  if(ffmpegInstance) return ffmpegInstance;
  const { FFmpeg } = FFmpegWASM;
  const { toBlobURL } = FFmpegUtil;
  const ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({message}) => { /* verbose; keep quiet */ });
  const base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
  });
  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

async function convertToOgg(track){
  const ffmpeg = await getFfmpeg();
  const { fetchFile } = FFmpegUtil;
  const inName = "in_"+track.id;
  const outName = track.id+".ogg";
  await ffmpeg.writeFile(inName, await fetchFile(track.file));
  await ffmpeg.exec(["-i", inName, "-c:a", "libvorbis", "-q:a", "6", "-ar", "44100", outName]);
  const data = await ffmpeg.readFile(outName);
  const blob = new Blob([data.buffer], {type:"audio/ogg"});
  await ffmpeg.deleteFile(inName);
  await ffmpeg.deleteFile(outName);
  // duration, decoded from the final ogg so it matches what Minecraft will actually play
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    track.duration = Math.max(1, Math.round(buf.duration));
    ctx.close();
  }catch(e){ track.duration = 180; }
  return blob;
}

/* ---------------- pack assembly ---------------- */
function comparatorFor(durationSeconds){
  return Math.min(15, Math.max(1, Math.round(durationSeconds/30)));
}

async function canvasToPngBytes(canvas){
  return new Promise((resolve)=>{
    canvas.toBlob(async (blob)=>{
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

async function generateAll(){
  const namespace = ($("#namespace").value.trim() || "customdiscs").toLowerCase().replace(/[^a-z0-9_.-]/g,"_");
  const packName = $("#packname").value.trim() || "Custom Discs";
  if(!tracks.length) return;

  genBtn.disabled = true;
  progWrap.style.display = "block";
  logEl.innerHTML = "";
  setProgress(2);
  log("Starting build for "+tracks.length+" track(s), namespace \""+namespace+"\"…");

  const zip = new JSZip();
  const dp = zip.folder("datapack");
  const rp = zip.folder("resourcepack");
  const mod = zip.folder("fabric-mod");
  const geyser = zip.folder("geyser");

  // ---- pack.mcmeta (26.2 -> pack_format 107) ----
  const PACK_FORMAT = 107;
  dp.file("pack.mcmeta", JSON.stringify({
    pack: { pack_format: PACK_FORMAT, description: packName + " (datapack)" }
  }, null, 2));
  rp.file("pack.mcmeta", JSON.stringify({
    pack: { pack_format: PACK_FORMAT, description: packName + " (resource pack)" }
  }, null, 2));

  const dpNs = dp.folder("data").folder(namespace);
  const jukeboxDir = dpNs.folder("jukebox_song");
  const fnDir = dpNs.folder("function");

  const rpNs = rp.folder("assets").folder(namespace);
  const itemsDir = rpNs.folder("items");
  const modelsDir = rpNs.folder("models").folder("item");
  const texDir = rpNs.folder("textures").folder("item");
  const soundsDir = rpNs.folder("sounds").folder("records");
  const langEntries = {};

  const modNs = mod.folder("src").folder("main");
  const modResources = modNs.folder("resources");
  const modAssetsNs = modResources.folder("assets").folder(namespace);
  const modItemsDir = modAssetsNs.folder("items");
  const modModelsDir = modAssetsNs.folder("models").folder("item");
  const modTexDir = modAssetsNs.folder("textures").folder("item");
  const modSoundsDir = modAssetsNs.folder("sounds").folder("records");
  const modDataNs = modResources.folder("data").folder(namespace);
  const modJukeboxDir = modDataNs.folder("jukebox_song");

  const giveLines = [];
  const geyserMappings = [];
  const soundsJson = {};
  const modSoundsJson = {};

  let i = 0;
  for(const t of tracks){
    i++;
    log(`[${i}/${tracks.length}] ${t.file.name} → converting to OGG Vorbis…`);
    setProgress(5 + (i-1)/tracks.length*70);
    let oggBlob;
    try{
      oggBlob = await convertToOgg(t);
    }catch(e){
      log("  ffmpeg conversion failed: "+e.message, "err");
      continue;
    }
    const oggBytes = new Uint8Array(await oggBlob.arrayBuffer());
    const pngBytes = await canvasToPngBytes(t.canvas);
    const id = t.id;
    const title = t.title || "Unknown Title";
    const artist = t.artist || "Unknown Artist";
    const soundEventId = `${namespace}:${id}`;
    const langKey = `jukebox_song.${namespace}.${id}`;
    langEntries[langKey] = `${title} - ${artist}`;

    // datapack: jukebox_song
    const jukeboxJson = {
      sound_event: soundEventId,
      description: { translate: langKey },
      length_in_seconds: t.duration,
      comparator_output: comparatorFor(t.duration)
    };
    jukeboxDir.file(id+".json", JSON.stringify(jukeboxJson, null, 2));
    modJukeboxDir.file(id+".json", JSON.stringify(jukeboxJson, null, 2));

    // resourcepack: item model + item definition + texture + sound
    const modelJson = {
      parent: "minecraft:item/generated",
      textures: { layer0: `${namespace}:item/${id}` }
    };
    modelsDir.file(id+".json", JSON.stringify(modelJson, null, 2));
    modModelsDir.file(id+".json", JSON.stringify(modelJson, null, 2));

    const itemDefJson = { model: { type: "minecraft:model", model: `${namespace}:item/${id}` } };
    itemsDir.file(id+".json", JSON.stringify(itemDefJson, null, 2));
    modItemsDir.file(id+".json", JSON.stringify(itemDefJson, null, 2));

    texDir.file(id+".png", pngBytes);
    modTexDir.file(id+".png", pngBytes);

    soundsDir.file(id+".ogg", oggBytes);
    modSoundsDir.file(id+".ogg", oggBytes);
    soundsJson[id] = { sounds: [`records/${id}`], subtitle: langKey };
    modSoundsJson[id] = { sounds: [`records/${id}`], subtitle: langKey };

    // give command
    const nameComp = JSON.stringify({text:title});
    const loreComp = JSON.stringify([{text:artist, italic:true, color:"gray"}]);
    giveLines.push(
      `give @s minecraft:music_disc_11[item_model="${namespace}:${id}",jukebox_playable={song:"${soundEventId}"},custom_name='${nameComp}',lore=[${loreComp.slice(1,-1)}]]`
    );

    // geyser custom item mapping (Geyser 2.x custom_mappings format)
    geyserMappings.push({
      name: `${namespace}_${id}`,
      item: "minecraft:music_disc_11",
      icon: `${namespace}_${id}`,
      predicate: { property: "minecraft:custom_model_data", index: 0, fallback: false },
      custom_model_data: id.length // placeholder distinguishing value; see README for matching real values
    });

    log(`  ✓ ${title} — ${artist} (${t.duration}s, comparator ${comparatorFor(t.duration)})`, "ok");
    setProgress(5 + i/tracks.length*70);
  }

  rpNs.file("sounds.json", JSON.stringify(soundsJson, null, 2));
  modAssetsNs.file("sounds.json", JSON.stringify(modSoundsJson, null, 2));
  rpNs.folder("lang").file("en_us.json", JSON.stringify(langEntries, null, 2));
  modAssetsNs.folder("lang").file("en_us.json", JSON.stringify(langEntries, null, 2));

  fnDir.file("give_all.mcfunction", giveLines.join("\n")+"\n");
  giveLines.forEach((line, idx) => fnDir.file(`give_${tracks[idx] ? tracks[idx].id : idx}.mcfunction`, line+"\n"));

  // ---- fabric.mod.json ----
  const fabricModJson = {
    schemaVersion: 1,
    id: namespace,
    version: "1.0.0",
    name: packName,
    description: `Adds ${tracks.length} custom music disc(s), generated by Disc Press.`,
    authors: ["Disc Press user"],
    environment: "*",
    license: "CC0-1.0",
    depends: { fabricloader: ">=0.16.0", minecraft: "~26.2", "fabric-resource-loader-v0": "*" }
  };
  modResources.file("fabric.mod.json", JSON.stringify(fabricModJson, null, 2));

  mod.file("build.gradle", buildGradle());
  mod.file("settings.gradle", `pluginManagement {\n  repositories {\n    maven { url 'https://maven.fabricmc.net/' }\n    gradlePluginPortal()\n  }\n}\n`);
  mod.file("gradle.properties", gradleProperties());
  mod.file("README.md", modReadme(namespace));

  // ---- geyser mapping ----
  geyser.file("custom_items.json", JSON.stringify({
    format_version: "1", identifier: "custom_items", items: { music_disc_11: geyserMappings.map(m=>({
      name: m.name, custom_model_data: m.custom_model_data, icon: m.icon
    })) }
  }, null, 2));

  zip.file("README.txt", topReadme(namespace, PACK_FORMAT));

  setProgress(90);
  log("Packing zip…");
  const blob = await zip.generateAsync({type:"blob"}, (meta)=>{ setProgress(90 + meta.percent/10); });
  setProgress(100);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = namespace+"_disc_pack.zip";
  document.body.appendChild(a); a.click(); a.remove();
  log("Done — download started: "+namespace+"_disc_pack.zip", "ok");
  genBtn.disabled = false;
}

function buildGradle(){
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
function gradleProperties(){
return `# Fill these in from https://fabricmc.net/develop for Minecraft 26.2 —
# they change frequently and are deliberately left as placeholders here.
minecraft_version=26.2
yarn_mappings=26.2+build.1
loader_version=0.16.9
fabric_version=0.100.0+26.2
mod_version=1.0.0
maven_group=com.discpress
`;
}
function modReadme(namespace){
return `# ${namespace} — Fabric music disc mod

This is a plain resource+data bundle wrapped as a Fabric mod jar. There is
no Java code: item textures/models, sound events, and jukebox_song entries
under src/main/resources are picked up automatically by Minecraft the same
way a resource pack + datapack would be, because mod jars are merged into
both the resource and data systems.

## Building

1. Open gradle.properties and fill in the real yarn_mappings / loader_version /
   fabric_version for Minecraft 26.2 from https://fabricmc.net/develop —
   these are placeholders and change often, so they are not baked in.
2. From this folder, run:
       ./gradlew build          (Linux/macOS)
       gradlew.bat build        (Windows)
3. The built jar appears in build/libs/. Drop it into your .minecraft/mods
   folder alongside Fabric Loader + Fabric API for 26.2.

All compiling happens on your machine — nothing here is pre-built.
`;
}
function topReadme(namespace, packFormat){
return `Disc Press output
==================

Target version: Minecraft 26.2 (pack_format ${packFormat})

Contents
--------
datapack/       - drop the CONTENTS of this folder into a world's
                   .minecraft/saves/<world>/datapacks/${namespace}/ folder,
                   or zip it and use as a datapack.
resourcepack/    - same idea, goes in .minecraft/resourcepacks/, or zip it.
fabric-mod/      - full Gradle project source. Run the build yourself
                   (see fabric-mod/README.md) — nothing is precompiled.
geyser/          - custom_items.json for Geyser's custom item mapping
                   system, so Bedrock players via Geyser see correct icons.
                   Geyser needs its own mapping regardless of the resource
                   pack; see Geyser's docs for where to place this file and
                   how to match the custom_model_data / icon fields to a
                   texture you add to Geyser's packaged textures.

Getting discs in-game
----------------------
Each track gets its own /give command in
datapack/data/${namespace}/function/give_all.mcfunction — run it as
/function ${namespace}:give_all (or the per-track functions) once the
datapack is loaded.

Notes on 26.2
-------------
26.2 uses the new item-component system: item_model, jukebox_playable,
custom_name and lore are all set directly on the item stack via the give
command rather than through legacy NBT tags. pack_format ${packFormat}
matches the Java Edition 26.2 release; if Mojang ships a later 26.x drop
before you use this, bump the pack_format value in both pack.mcmeta files
to match (check the Minecraft Wiki's version page for the new number).

Only the resourcepack and datapack are needed for a vanilla server/client
combo. Use fabric-mod instead of (or alongside) them if you want the discs
bundled as an actual mod, e.g. for a modded Fabric server.
`;
}

genBtn.addEventListener("click", generateAll);

/* preload template as soon as possible */
loadTemplate();
refreshEmpty();
})();