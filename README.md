# Translate

Point your camera at a menu or sign and read it in your language. The
translation is drawn over the photo, in place.

A Cloudflare Worker serving a static frontend, with Mistral Document AI for OCR
and a Mistral chat model for translation.

## How it works

```
photo  →  browser: EXIF rotate, downscale to 1600px, JPEG → data URL
       →  POST /api/translate
       →  Worker: Mistral OCR (include_blocks)  →  text + a box per block
       →  Worker: one chat call, all blocks together, JSON schema out
       →  browser: sample each box's colour from the photo, draw the chips
```

Two API calls per photo. OCR finds *where* the text is; the chat model
translates *what* it says. OCR cannot translate, and the chat model cannot be
trusted with coordinates, so each does only its half.

**The join is by id, never by text.** The Worker assigns an id to each block and
the model must echo it back. A reworded translation therefore cannot detach from
its box. Ids the model drops fall back to the source text and are reported as
`translatedOk: false`.

**Coordinates are pixels in the uploaded image's space**, and OCR echoes that
image's dimensions back. The browser displays that exact bitmap in a frame
locked to its aspect ratio, so positioning each chip is a percentage of the
frame — no scaling maths, and it stays correct at any screen size.

The browser does all the pixel work — decode, rotate, downscale, encode, sample,
render — so the Worker never touches image data and stays far from its CPU limit.

## Structure

```
src/
  index.ts      routes, validation, joins translations back to boxes
  mistral.ts    the two Mistral calls, markdown stripping, block filtering
public/
  index.html    all screens as stacked layers
  styles.css    body[data-state] decides which layer and dock are visible
  sw.js         caches the app shell; never caches /api
  js/
    main.js     session state, wiring, boot  (entry point)
    camera.js   permission primer, live stream, capture
    image.js    EXIF, downscale, JPEG encode
    api.js      the two calls to our own Worker
    overlay.js  colour sampling, chip layout, PNG export
    install.js  PWA install prompt gating
    ui.js       element handles, screen state, sheet, toasts
```

Screens are driven entirely by `body[data-state]`: `primer`, `camera`,
`captured`, `working`, `result`, `upload`. JavaScript sets the attribute; CSS
decides what is visible.

Phones and tablets (`pointer: coarse`) open on the camera. Desktops open on the
upload card and can opt into the camera.

## Running it

```sh
npm install
npm run dev          # http://localhost:8787
```

Needs `MISTRAL_API_KEY` in `.env` at the project root:

```
MISTRAL_API_KEY=...
```

After changing bindings in `wrangler.jsonc`, regenerate types:

```sh
npm run cf-typegen
```

## Deploying

The local `.env` is not uploaded. Set the key as a Worker secret once, then
deploy:

```sh
npx wrangler secret put MISTRAL_API_KEY
npm run deploy
```

## Configuration

Both models are `vars` in `wrangler.jsonc`, so they can be changed without
touching code:

| Var | Default | Notes |
| --- | --- | --- |
| `OCR_MODEL` | `mistral-ocr-latest` | Must be OCR 4 or newer. Older models return no `blocks`, and the overlay has nothing to position. |
| `TRANSLATE_MODEL` | `mistral-small-latest` | Any chat model that honours `json_schema`. Reasoning models work but are slower for no quality gain here. |

## Things that will bite you

**Every module must be listed in `SHELL` in `sw.js`.** Miss one and an offline
launch stalls on a failed import — the page loads and the app never starts. Bump
`CACHE` whenever a shell file changes; `activate` deletes the older caches.

**The service worker serves stale JavaScript during development.** Hard-reload,
or enable DevTools → Application → *Update on reload*.

**The camera and PWA install both require a secure context.** `localhost` works.
A LAN IP over plain `http` does not, which is baffling unless you know — the app
detects it and says so.

**OCR drops text separated by a wide horizontal gap.** A menu with
right-aligned prices in a separate column loses the prices entirely; the same
menu with dotted leaders, so the price sits in the same run of text, keeps them.
This is a model limitation, not something the Worker can correct.

**Translations can be longer than the source.** Each chip shrinks its font to
fit, down to a floor. Below that the text is clipped, marked with a fade, and
the full text is available by tapping the region.

## Load-bearing details

These look like cleanup opportunities and are not:

- `pointer-events: none` on inactive `.layer` / `.dock`. A `visibility`
  transition keeps an outgoing layer hit-testable for the whole fade, where it
  swallows clicks meant for the screen replacing it.
- `[hidden] { display: none !important }`. Class rules such as
  `.toast { display: flex }` out-specify the browser's own `[hidden]` rule, which
  silently stops the attribute working.
- The crop in `captureVisibleFrame`. The viewfinder is `object-fit: cover`, so
  capturing the raw camera frame would include text the user never saw.
- Opaque translation chips. Their colour is sampled from the photo directly
  underneath, so making them translucent blends a colour into itself and costs
  legibility for no visual gain.
