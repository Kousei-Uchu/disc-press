# Disc Press

Turn your own audio files into playable Minecraft music discs. Disc Press runs entirely in your browser, converts your audio, generates disc artwork, and packages everything into a datapack and resource pack for Minecraft 26.2. Nothing is uploaded anywhere.

## Features

- Drop in any audio file (mp3, wav, flac, m4a, aac, opus, ogg, and more), converted locally to OGG Vorbis
- Reads embedded title, artist, and cover art from your files automatically
- Generates a unique disc texture per track, colors pulled from the cover art
- Manual color picker if you want to override the generated palette
- Outputs a ready-to-use datapack and resource pack targeting data pack format 107.1 / resource pack format 88.0
- Adds a "blank disc" item obtainable from a level 5 librarian trade, which can be turned into any of your custom discs with a stonecutter
- Includes a Geyser v2 item mapping and a small Bedrock resource pack so the discs show up correctly for Bedrock players connecting through Geyser

## Using it

Open `index.html` (or the hosted version, if you're running this from a static site) in a browser, add your tracks, and click generate. You'll get a zip containing a `datapack/` folder and a `resourcepack/` folder, each ready to drop into a world's `datapacks/` or a `resourcepacks/` folder respectively.

## Running it locally

This is a static site with no build step. Any static file server works:

```
npx serve .
```

## How it works

**Audio conversion.** Files are decoded and re-encoded to OGG Vorbis in the browser using an ffmpeg.wasm build, so no server ever sees your files.

**Disc art.** Each disc texture is built from two 16x16 template layers (a main body layer and a ring/label layer). The app reads the brightness and alpha of each template pixel, then repaints it using a track-specific main color and ring color. Colors come from the track's embedded cover art (or a deterministic generated color if there's no cover art), picked with a small weighted k-means pass over a coarse color histogram, which holds up better across muted or low-saturation art than a plain hue sort.

**Getting discs in survival.** The pack adds a "blank disc," which is really a reskinned Knowledge Book with no jukebox function of its own. A level 5 librarian sells it for emeralds and an amethyst shard. Put a blank disc in a stonecutter and pick a recipe to turn it into any of your custom discs. Knowledge books have no natural source in survival and don't appear in the creative menu, so nothing else a player is holding can accidentally trigger these recipes, and the finished discs never have to double as an ingredient.

**Bedrock support.** The zip includes a Geyser v2 custom item mapping plus a minimal Bedrock resource pack containing just the disc icon textures, so Bedrock players connected through Geyser see the correct name and icon instead of a placeholder item.

## Roadmap

A Fabric mod export (packaging the same content as an installable mod jar instead of a datapack/resourcepack pair) is built but not yet wired into the UI. See `CONTRIBUTING.md` if you want to help finish it off.

## License

MIT
