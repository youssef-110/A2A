# The A2A film

The 40-second film on the landing page (`packages/web/public/media/film.mp4`, `film-720.mp4`,
`film-poster.jpg`, captions in `film.vtt`). It is a canvas film: `film.js` paints any frame as a pure
function of time, timed in beats on the 126 bpm grid in `beats.json`. The screens are real captures of
the dashboard (`assets/shots/`, from a local relay with the simulated swarm, `pnpm demo:swarm`).
Ping is drawn from the same geometry as `packages/web/public/ping.js`.

| beats | seconds | scene |
|---|---|---|
| 0-16 | 0.0-7.6 | "Your agent talks to theirs." rises word by word; the lines part; two A's meet and the lime link connects them; the camera dives through the link |
| 16-32 | 7.6-15.2 | Lime: "One prompt. Every app." Five apps report ready, one per beat. The dashboard rises; Ping drops in: "Juno (Cursor) joined" |
| 32-48 | 15.2-22.9 | "Ask your agent to ask theirs." The real conversation; Ping throws the question out and catches the answer |
| 48-64 | 22.9-30.5 | "Every message passes the guard." A request for a key types itself, is flagged, HELD stamps down; the real Review page; Ping, amber and stern |
| 64-80 | 30.5-38.1 | Lime: "Meet Ping." Joined, sent, received, held, then done with a spin and square sparks |
| 80-84 | 38.1-40.0 | The mark assembles. "Your agent can talk to theirs. Free while in beta." |

## Re-render

It is built with the motion-reel skill. From an empty folder:

1. Copy this folder in as `a2a/`, and add the faces it expects:
   `fonts/display.woff2` (Archivo-Variable), `fonts/ui.woff2` (Geist-Variable) and
   `fonts/mono.woff2` (GeistMono-Variable), all from `packages/web/public/fonts/`.
2. Music: `uv run <skill>/scripts/beats.py a2a --synth --flavor house --mode minor --tonic D --drop 4`
   (it writes `audio/music.wav` and the same `beats.json`).
3. `node <skill>/scripts/render.mjs --film a2a --format 16x9 --video-only --fps 30`, then
   `node <skill>/scripts/sfx.mjs a2a` and `node <skill>/scripts/mix.mjs a2a` (sound effects come from
   the `HITS` list in `film.js`; the mix is mastered to -14 LUFS).
4. Encode for the site from `out/a2a/final.mp4`:
   `ffmpeg -i final.mp4 -c:v libx264 -preset slow -crf 25 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 160k film.mp4`,
   the same with `-vf scale=1280:720 -crf 27 -b:a 128k` for `film-720.mp4`, and a still at 31.9 s for the poster.

If the scene timings change, update the chapter buttons in `index.html` (`data-t`, `data-end`) and `film.vtt`.
