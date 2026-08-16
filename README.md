# bfxr-mcp

Game sound effects, two ways: an **MCP server** so an assistant can make them for
you, and a **local web app** where you type what you want, hear the variations,
and download them. Both write to the same folder and share one library, so a sound
Claude generates over MCP shows up on the page and vice versa.

The synthesis code is vendored verbatim from [increpare/bfxr2](https://github.com/increpare/bfxr2)
(MIT) and run in a Node `vm` sandbox, so the output is the same DSP the
[Bfxr](https://www.bfxr.net/) website produces — no browser, no reimplementation.

## Install

```sh
npm install
```

Files land in `$BFXR_OUTPUT_DIR`, defaulting to `~/Downloads/bfxr-sounds`. Every tool
also takes an `output_dir` argument. Existing files are never overwritten — a second
`coin.wav` becomes `coin-2.wav`.

Then register the MCP server with your client. A config file on disk is not enough —
the client has to load it, and a chat that started before that will not see the tools.

### Cursor

This repo already ships [`.cursor/mcp.json`](.cursor/mcp.json). Open **this folder** as
the workspace, then:

1. **Cursor Settings → MCP** (or **Customize → MCP** in the sidebar).
2. Find **bfxr** and turn it on. Cursor may ask you to approve a local stdio server.
3. If the status is not green, fully quit Cursor and reopen it.
4. Start a **new** Agent chat. Tools are bound when the conversation starts, so an
   already-open thread will still say it has no Bfxr access.

To use Bfxr while working in a *different* project (a game repo, etc.), add it
globally instead. Put this in `~/.cursor/mcp.json`, with a real absolute path:

```json
{
  "mcpServers": {
    "bfxr": {
      "command": "node",
      "args": ["/absolute/path/to/bfxr-mcp/src/index.js"],
      "env": { "BFXR_OUTPUT_DIR": "${userHome}/Downloads/bfxr-sounds" }
    }
  }
}
```

Project config (`.cursor/mcp.json`) and global config (`~/.cursor/mcp.json`) are
merged; if the same name appears in both, the project file wins.

If it still does not connect: **View → Output**, pick **MCP Logs** from the dropdown.

### Claude Code

From this repo:

```sh
claude mcp add --scope user bfxr -- node "$(pwd)/src/index.js"
```

`--scope user` keeps it available in every Claude Code session, not just this folder.

### Other MCP clients

Anything that reads an MCP config file:

```json
{
  "mcpServers": {
    "bfxr": {
      "command": "node",
      "args": ["/absolute/path/to/bfxr-mcp/src/index.js"],
      "env": { "BFXR_OUTPUT_DIR": "~/Downloads/bfxr-sounds" }
    }
  }
}
```

## The web app

```sh
npm run web          # → http://localhost:4747
```

Type a description, get several variations, click to play. Rename them, drop them
into groups, star the keepers, download one `.wav` or a whole group as a `.zip`.
`↻` makes small variations of a sound you like; `↗` opens it on bfxr.net to tweak
by ear. It serves on loopback only and reads/writes the same output folder as the
MCP server.

`BFXR_PORT` picks the port (default 4747, next free port if taken).

### How the prompt box works

Two designers, chosen automatically:

| | When | What it does |
| --- | --- | --- |
| **Keyword mapper** | always available, no setup | Matches words against a built-in lexicon — "coin/laser/explosion…" picks the preset, "deep, crunchy, wobbly, short, metallic…" adjust the parameters. Instant, offline, deterministic. |
| **Claude API** | `ANTHROPIC_API_KEY` set, or an `ant auth login` profile | Sends your description plus the full parameter reference to `claude-opus-5` and gets back real Bfxr parameters. Better with unusual requests ("a wet slap on cardboard"). Costs API credits. |

The badge in the top right shows which one is live. Claude is used when credentials
exist; any failure falls back to the keyword mapper and says so. Force the offline
one with `BFXR_DESIGNER=keywords`.

## MCP tools

| Tool | What it does |
| --- | --- |
| `generate_sound` | Synthesize from a preset (`pickup_coin`, `laser_shoot`, `explosion`, `powerup`, `hit_hurt`, `jump`, `blip_select`, `random`, `tone`) plus optional parameter overrides. `count` gives you several randomized variations at once. |
| `mutate_sound` | Small random variations on a sound you already like, from a permalink, a `.bfxr` file, or raw params. |
| `load_sound` | Decode a bfxr.net permalink or `.bfxr` file back into parameters, optionally re-rendering the `.wav`. |
| `list_parameters` | All 32 parameters with ranges, defaults and descriptions, plus presets and waveforms. |
| `play_sound` | Play a `.wav` through the local speakers (`afplay` / `paplay` / `aplay` / PowerShell). |

Every generated sound comes back with a `https://www.bfxr.net/?sfx=...` permalink, so
you can open it in the web app and tweak it by ear — the assistant can't hear its own
output, which is why asking for 3–5 variations and picking one works better than
iterating blind.

`save_bfxr: true` also writes a `.bfxr` project file next to each `.wav`, loadable via
"Open Data" on bfxr.net. `embed_audio: true` returns the audio inline in the tool
result for clients that can play it.

### Reproducibility

Presets randomize themselves, and noise waveforms are random at render time. Pass
`seed` to pin both: the same call with the same seed always yields byte-identical
audio. With `count > 1`, variation *i* uses `seed + i`.

## Example

> "Make me a laser sound for a small enemy — a few options"

```
generate_sound { preset: "laser_shoot", name: "enemy_laser", count: 4, seed: 12 }
→ ~/Downloads/bfxr-sounds/enemy_laser-{1..4}.wav
```

> "The second one, but lower and longer"

```
load_sound  { source: "<permalink for #2>" }
generate_sound { name: "enemy_laser_deep", params: { ...tweaked frequency_start, decayTime } }
```

## Layout

```
src/index.js       MCP server + tool definitions
src/web.js         local HTTP server for the web app
src/ui/index.html  the page (no build step, no dependencies)
src/engine.js      loads the vendored Bfxr synth in a vm, params/permalinks/rendering
src/sounds.js      render → .wav → library entry (shared by MCP and web)
src/library.js     library.json: the index of every sound in the output folder
src/design.js      keyword prompt → preset + parameters
src/claude.js      optional Claude API designer
src/wav.js         16-bit mono PCM WAV encoder
src/zip.js         minimal zip writer for pack downloads
src/output.js      output paths, safe filenames, playback
vendor/bfxr2/      verbatim copies of the upstream synth files (MIT, see LICENSE)
test/              node --test suites
```

`library.json` lives in the output folder next to the `.wav` files. Deleting a `.wav`
by hand is safe — orphaned entries are dropped on the next read. It's read-modify-write
with no locking, so don't generate from the web app and an MCP client at the same
instant.

To refresh the vendored engine, copy these files from a checkout of bfxr2 and update
`vendor/bfxr2/UPSTREAM_COMMIT.txt`:

```
js/globals.js  js/synths/templates.js  js/audio/AKWF.js
js/audio/Bfxr_DSP.js  js/synths/SynthBase.js  js/synths/Bfxr.js
```

They are loaded in that order (matching upstream `index.html`) and concatenated into a
single script, so top-level `class` declarations resolve across files the way they do
with `<script>` tags.

## Deviation from upstream

`mutate_sound` deliberately skips Bfxr's `rectify_params()` step. Upstream's Mutate
button re-rolls the base frequency and punch outright; here mutations stay recognizably
close to the source sound, which is what you want when refining something you like.

## Tests

```sh
npm test
```

Covers the synth and WAV output, the web API end-to-end (a real server on a temp
folder), the keyword designer, and the zip writer. The Claude designer is tested
against a stub Messages endpoint — request shape and response handling are real, but
nothing here has been run against the live API.

## Credits

Bfxr and Bfxr2 by [increpare](https://www.increpare.com/) (Stephen Lavelle), built on
DrPetter's Sfxr and Tom Vian's as3sfxr. Vendored under MIT — see `vendor/bfxr2/LICENSE`.
