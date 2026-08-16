# Agent notes

## Sound effects

Never play audio. The user always plays sounds in the local library UI.

- Do not call `play_sound`
- Do not set `play` or `embed_audio` on `generate_sound` / `mutate_sound`
- After generating or mutating, refresh the library web app in Cursor (`http://localhost:4747`, or start it with `npm run web` if it is down)
