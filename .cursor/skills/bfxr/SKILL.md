---
name: bfxr
description: Generate, mutate, and review Bfxr game sound effects via the bfxr MCP server and local library UI. Use when making SFX, calling generate_sound or mutate_sound, or when the user mentions bfxr, 8-bit sounds, or the sound library.
---

# Bfxr sounds

## Playback

Never play audio. The user always plays sounds themselves.

- Do not call `play_sound`
- Do not set `play: true`
- Do not set `embed_audio: true`

## After generating or mutating

1. Leave `play` and `embed_audio` unset.
2. Prefer `count` 3–5, then report file paths and bfxr.net permalinks.
3. Refresh the library web app in Cursor:
   - If Cursor Browser / Simple Browser tools are available, navigate or reload `http://localhost:4747` (or the next port the server printed).
   - If the library server is not running, start it with `npm run web` first, then open that URL in Cursor's browser pane.
4. Do not play the new files. The user will audition them in the library UI.

The library page live-reloads when MCP writes files. Still reload the Cursor browser pane after each batch so it is in front with the new sounds.
