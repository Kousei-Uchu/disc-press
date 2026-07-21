# Contributing to Disc Press

Thanks for taking a look. This is a small static-site project, so getting set up should only take a minute.

## Getting set up

1. Clone the repo.
2. Serve the folder with any static file server, for example:
   ```
   npx serve .
   ```
3. Open the served URL in a browser and you're good to go. There's no build step and no dependencies to install; everything is loaded from CDN in `index.html`.

## Project layout

```
index.html       page markup and styling
src/main.js       all the app logic: audio conversion, disc art generation, pack assembly
```

`main.js` is a single module split into loose sections (utility helpers, color math, disc template rendering, track state, the color picker modal, drag and drop, ffmpeg conversion, and pack assembly). Keep new code close to the section it belongs in.

## Making changes

- Keep everything client-side. No track data, audio, or metadata should ever leave the browser.
- Test with a handful of real audio files, including at least one with no embedded cover art, to make sure the fallback color generation still looks right.
- If you change anything in the generated pack (item components, recipe format, jukebox_song fields, and so on), check it against the current Minecraft data pack and resource pack formats referenced in `README.md`. Formats change between snapshots, so double-check before assuming an older guide still applies.
- If you touch the SNBT used in `/give` commands, remember that command arguments are parsed as SNBT, not JSON. Wrapping a component value in an extra pair of quotes turns it into a literal string instead of a parsed component.

## The Fabric mod export

There's a `INCLUDE_FABRIC_MOD` flag near the top of `src/main.js`. The code to package everything as a Fabric mod project (`fabric.mod.json`, Gradle files, and so on) is already written but switched off while it's finished off properly. If you want to pick this up:

- Flip the flag to `true` locally to see the current state of the output.
- The mod side needs a pass to make sure the generated `fabric.mod.json` and Gradle files track whatever the current Fabric Loader/API versions are for the target Minecraft version, rather than the placeholder values currently in `gradleProperties()`.
- Once it's solid, it also needs a small UI affordance (a checkbox or similar) so people can opt into it, and a short section in the README explaining how to build the resulting jar.

## Reporting issues

If a generated pack doesn't load, doesn't show discs correctly, or the librarian trade doesn't appear, please include:

- Your Minecraft version
- Whether you're using the datapack/resourcepack combo, and whether Geyser is involved
- Any errors from the in-page log, or from the game's own logs

## Pull requests

Keep pull requests focused on one change. If you're proposing something larger (a new export format, a different color extraction approach, and so on), opening an issue first to talk it through is appreciated before you put in the work.
