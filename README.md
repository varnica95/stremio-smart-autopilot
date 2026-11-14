# Stremio Smart AutoPilot

A Stremio addon that removes the "which stream do I pick?" step. You open a movie or episode, and AutoPilot:

1. asks every source you have configured for streams, all at once and with a time limit for each;
2. removes duplicates and releases you never want (CAM, telesync, outside your resolution range);
3. **tests** the most promising HTTP links with a small ranged download, measuring response time and speed;
4. ranks everything with a configurable scoring profile and puts the best stream first, marked ⭐, with a short explanation of *why* it is first;
5. returns subtitles in your languages (Croatian → English → original language by default), with the ones most likely to be in sync with your file first.

It only uses sources you configure and are authorized to use. It ships with the Internet Archive (public-domain and openly licensed films), your own media library, and a connector for other Stremio addons you choose to include. It does not bypass logins, paywalls, DRM or provider restrictions.

---

## Contents

- [What is automatic and what is not](#what-is-automatic-and-what-is-not)
- [What a Stremio addon can and cannot control](#what-a-stremio-addon-can-and-cannot-control)
- [Requirements](#requirements)
- [Install and run locally](#install-and-run-locally)
- [Install the addon in Stremio](#install-the-addon-in-stremio)
- [Configuration](#configuration)
- [How ranking works](#how-ranking-works)
- [Subtitles](#subtitles)
- [The companion (automatic fallback)](#the-companion-automatic-fallback)
- [Architecture](#architecture)
- [Adding a new provider](#adding-a-new-provider)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## What is automatic and what is not

| Step | Status |
|---|---|
| Querying all configured sources in parallel, with timeouts | ✅ Automatic |
| Removing duplicates (same torrent/file, same URL, identical mirrors) | ✅ Automatic |
| Testing HTTP links before listing them (reachability, response time, speed) | ✅ Automatic |
| Ranking and putting the best stream first, with an explanation | ✅ Automatic |
| Remembering which sources failed or were slow and ranking them lower next time | ✅ Automatic (history fades within hours) |
| Finding subtitles in your languages, ordered by sync likelihood | ✅ Automatic |
| Keeping the same source for the next episode | ✅ Automatic via Stremio's `bingeGroup` (when Stremio's auto-play next episode is on) |
| Starting playback of the top stream | 👆 You tap it (Stremio does not let an addon start playback) |
| Turning a subtitle on | ⚙️ Automatic once you set *Default subtitle language* in Stremio's player settings (one-time) |
| Switching to the next stream if one fails | ✅ Automatic for HTTP streams **with the companion enabled** (before playback starts) · 👆 otherwise go back and tap the next stream |
| Switching streams in the middle of playback | ❌ Not possible (see below) |

## What a Stremio addon can and cannot control

These were the constraints that shaped the design. The addon protocol is plain HTTP request/response: Stremio asks the addon for `/manifest.json`, `/stream/{type}/{id}.json` and `/subtitles/{type}/{id}.json`, and the addon answers with JSON. There is nothing else.

| Question | Answer |
|---|---|
| Can an addon detect playback failures? | **No.** Stremio does not send playback events, errors or progress to addons. |
| Can it know whether a stream actually started? | **No**, not through the protocol. The only signal available is indirect: if the addon serves the video URL itself (the companion), it sees whether the player requested bytes and whether the source delivered them. |
| Can it detect buffering or stalls? | **No**, not directly. The companion can measure how fast the *source* delivers data while it proxies, which reveals slow sources but not the player's buffer state. |
| Can it switch the currently playing stream? | **No.** Stremio offers no API for it. The companion can only choose which source answers a request *before* the first byte is sent. |
| Can it choose which subtitle is shown? | **No.** The addon returns a list; Stremio's player picks one based on the user's *Default subtitle language* setting. |
| Can it see or reorder streams from other installed addons? | **No.** Stremio queries each addon separately and shows their results side by side. To rank several sources together, add them to AutoPilot as upstream providers instead. |

Anything beyond this (in-player failover, auto-switching mid-playback, subtitle forcing) would need a modified Stremio client or a custom player. AutoPilot does not pretend to do it.

## Requirements

- **Node.js 22.13 or newer** (uses the built-in `node:sqlite` module, so there is no native database driver to compile)
- npm
- Optional: an [OpenSubtitles.com API key](https://www.opensubtitles.com/consumers) for subtitles
- Optional: a [TMDB API key](https://www.themoviedb.org/settings/api) for the "original language" subtitle preference

## Install and run locally

```bash
npm install
cp .env.example .env        # then edit .env (at least OPENSUBTITLES_API_KEY if you want subtitles)
npm run dev                 # development, restarts on changes
# or
npm run build && npm start  # production
```

The server prints its URLs on start:

- `http://127.0.0.1:7000/configure` — settings and install page
- `http://127.0.0.1:7000/manifest.json` — addon manifest
- `http://127.0.0.1:7000/status` — provider health, measured host speeds, recent companion playback

## Install the addon in Stremio

**Same computer as the addon (desktop app):** open `http://127.0.0.1:7000/configure`, choose your settings, click **Install in Stremio**.

**Other devices (TV, phone) or a server:** Stremio only installs remote addons over **HTTPS**. Put the addon behind a reverse proxy with a certificate (Caddy, nginx, Cloudflare Tunnel, etc.), set `PUBLIC_URL=https://your-domain`, then open `https://your-domain/configure` and install from there, or paste the addon URL shown on that page into Stremio's addon search box.

**One-time Stremio setting for subtitles:** Settings → Player → *Default subtitle language* → your first language (e.g. Croatian). Without this, Stremio lists the subtitles but leaves them off.

### Deploy to Render (works from a phone)

1. Push this project to a GitHub repository.
2. On render.com: **New → Blueprint**, choose the repository. `render.yaml` sets everything up.
3. When asked, paste your `OPENSUBTITLES_API_KEY` (and optionally `TMDB_API_KEY`).
4. After the deploy finishes, open `https://<your-service>.onrender.com/configure` and install it.

`PUBLIC_URL` is filled in automatically from Render's `RENDER_EXTERNAL_URL`. Free instances sleep after about 15 minutes idle, so the first request after a break takes up to a minute. Link tests then describe Render's network, not yours.

## Configuration

There are two levels.

### Per user (in the addon URL)

Set on the `/configure` page and stored in the addon URL itself, so different people can install the same server with different settings. Stremio's **Configure** button on the installed addon reopens the page with your current values.

| Setting | Default | Meaning |
|---|---|---|
| Ranking profile | Best Overall | See [profiles](#ranking-profiles) |
| Preferred resolution | 1080p | Scores highest in Best Overall and Balanced |
| Minimum / maximum resolution | 720p / 2160p | Streams outside are hidden (unless nothing else exists) |
| Subtitle languages | `hr, en, original` | ISO 639-1 codes in priority order; `original` = the title's own language |
| Subtitles per language | 3 | |
| Maximum results | 10 | |
| Prefer smaller files when quality is comparable | on | |
| Prefer compatible audio | on | AAC/AC3/E-AC3 over DTS/TrueHD, which many TVs, phones and browsers cannot play |
| Hide low-quality releases | on | CAM, telesync, screener |

Invalid values never break the addon: they fall back to defaults and are logged.

### Per server (environment variables)

See [`.env.example`](.env.example) for every option with comments. The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | `http://127.0.0.1:PORT` | URL Stremio uses to reach the addon (HTTPS for remote) |
| `STREAM_PROVIDERS` | `internet-archive,local-library,upstream` | Which built-in providers to enable |
| `LIBRARY_FILE` | – | JSON file with your own media ([example](examples/library.json)) |
| `UPSTREAM_ADDONS` | `[]` | Other Stremio addons to include in ranking (JSON list of `{id,name,url}`) |
| `OPENSUBTITLES_API_KEY` | – | Enables subtitles |
| `TMDB_API_KEY` | – | Enables the "original language" subtitle preference |
| `PROBE_ENABLED` / `PROBE_MAX_STREAMS` | `true` / `6` | Test the top HTTP links before answering |
| `PROVIDER_TIMEOUT_MS` | `6000` | Time budget per provider |
| `COMPANION_ENABLED` | `false` | Automatic fallback proxy (local use) |
| `DATABASE_PATH` | `./data/autopilot.db` | SQLite cache and reliability history; empty = memory only |
| `DEFAULT_PREFERENCES` | – | JSON object overriding the per-user defaults above |

No credentials are hard-coded; all keys come from the environment and are redacted from logs.

## How ranking works

Each stream is scored on eight criteria, each between 0 and 1. A profile assigns weights; the final score is the weighted average **over the criteria that apply to that stream** (an HTTP link has no seeders, so seeders are left out rather than counted as zero).

| Criterion | What it uses | Notes |
|---|---|---|
| Availability / reliability | Live test result, plus time-decayed success history for the stream, its host and its provider | A failed test multiplies the whole score by 0.25: the stream drops to the bottom but stays as a last resort |
| Resolution | Your preferred/min/max | Going above your preference costs less than going below |
| Speed | Measured throughput (live test or earlier real playback) vs. the file's bitrate; response time | 2× the needed bitrate scores 1.0; below 1× produces a "buffering likely" warning |
| Seeders | Provider-reported count, logarithmic, **saturating at 200** | 2,000 seeders is *not* better than 200. Unverified seeders never raise availability above 0.6 |
| File size | Average bitrate vs. the normal range for that resolution | Implausibly small files are flagged as likely low quality or mislabeled |
| Video codec | Device compatibility (H.264 > HEVC > VP9 > AV1) | In *Lowest Bandwidth*, efficiency instead (AV1/HEVC first) |
| Audio codec | Compatibility | Only when *Prefer compatible audio* is on |
| Release quality | Remux > Blu-ray > WEB-DL > WEBRip > HDTV > DVD | |

So a torrent with 2,000 seeders whose last playback crawled at 60 KB/s and failed recently ranks below one with 200 seeders that delivered 6 MB/s; this exact case is covered by a test.

### Ranking profiles

| Weight | Best Overall | Best Quality | Fastest Start | Lowest Bandwidth | Balanced |
|---|---|---|---|---|---|
| Availability | 10 | 8 | 10 | 9 | 8 |
| Resolution | 9 (preferred) | 10 (highest) | 4 (preferred) | 6 (lowest) | 6 (preferred) |
| Speed | 9 | 5 | 10 | 5 | 6 |
| Seeders | 6 | 4 | 8 | 5 | 5 |
| File size | 4 (efficient) | 3 (bigger = better) | 6 (smaller) | 10 (smaller) | 5 (efficient) |
| Video codec | 4 | 3 | 6 | 5 (efficiency) | 5 |
| Audio codec | 4 | 4 | 5 | 3 | 5 |
| Release quality | 4 | 9 | 2 | 2 | 5 |

Weights live in [`src/core/ranking/profiles.ts`](src/core/ranking/profiles.ts).

### Reading a stream entry

```
AutoPilot
⭐ 1080p
Night of the Living Dead · h.264
💾 1.10 GB · 🎞 H.264
✅ Answered a test request 12s ago · ~8.4 MB/s
🏷 Internet Archive · score 87
👍 Ranked first (Best Overall): link answered a test request (140 ms); 1080p matches your preferred resolution
⚠️ (the most important warning, if any)
```

"Answered a test request" means exactly that: the server returned video bytes to the addon a moment ago. It is not a promise that playback will work on your device.

## Subtitles

- Provider: **OpenSubtitles.com REST API**, with your own API key. Searches by IMDb id (or parent IMDb id + season + episode), and by the **file hash** Stremio computes for the file you play.
- Order: language priority first (Croatian → English → original), then sync likelihood: exact hash match ≫ same release name/group ≫ same source family (Blu-ray vs WEB vs DVD) and matching frame rate (a 25 fps subtitle on a 23.976 fps film drifts within minutes). Machine-translated subtitles are pushed down. Duplicates are removed.
- Download quota: OpenSubtitles counts downloads, not searches. AutoPilot returns links to its own `/subtitles-file/...` route and only downloads a file when the player actually opens it, then caches it for 24 h.
- Language codes are returned as ISO 639-2 (`hrv`, `eng`), which Stremio displays and matches against its *Default subtitle language* setting.
- "Original language" needs `TMDB_API_KEY`; without it, that entry is skipped (the configure page says so).

## The companion (automatic fallback)

Because Stremio cannot tell an addon that playback failed, the only supported way to fall back automatically is for the addon to **be the URL the player opens**. With `COMPANION_ENABLED=true`, every HTTP stream in the list points to `PUBLIC_URL/companion/play/{session}/{n}`:

1. The player requests the video. The companion tries the source you tapped.
2. If that source does not answer correctly (error status, timeout, an HTML login page instead of video), the companion **immediately tries the next-ranked source**, before any video byte is sent. You just see playback start.
3. Once bytes flow, the source is **pinned**. Later range requests (seeking) go to the same file. If it fails then, only *identical mirrors* (same file name and size) are tried, because jumping to a different file mid-playback would corrupt the stream.
4. While proxying, it measures how fast the source delivers (not how fast the player reads) and records success, failure and speed. Those records lower failing or slow sources in the next ranking.
5. `/status` lists recent playback, the active source, problems detected ("source is slow", "source stopped during playback") and the next alternative to pick.

Use it when the addon runs on the same computer or home network as Stremio: all video bytes pass through the addon. Torrent streams are played by Stremio's own streaming server and cannot be proxied this way.

## Architecture

```
src/
  core/                 Pure domain logic. No I/O, no Stremio, no frameworks.
    models/             StreamCandidate, StreamHealth, SubtitleCandidate, UserPreferences, MediaRequest
    interfaces/         StreamProvider, SubtitleProvider, MetadataProvider, stores
    parsing/            Release-name parser (resolution, codecs, source, HDR, size, seeders)
    ranking/            Scorers, profiles, ranker (with explanations)
    dedupe.ts           Duplicate detection and mirror merging
  providers/
    streams/            Internet Archive, local library, Stremio-addon upstream, registry
    subtitles/          OpenSubtitles
    metadata/           Cinemeta (title/year/runtime), TMDB (original language)
  services/
    stream-discovery/   Concurrent discovery with timeouts, metadata merge, HTTP prober
    stream-ranking/     StreamService: discover → dedupe → pre-rank → test → rank
    subtitle-matching/  Language priority, sync scoring, de-duplication
    caching/            Memory, SQLite and tiered stores; read-through cache with request de-duplication
    reliability/        Time-decaying success/speed history per stream, host and provider
  stremio/              The only Stremio-specific layer
    manifest/           Manifest
    handlers/           Stream and subtitle handlers (parse id + config, call services, format)
    formatters/         Stream objects and labels
    pages/              Configure/install page, status page
    addon.ts            addonBuilder wiring (official SDK)
  companion/            Failover sessions and proxy
  infrastructure/       SQLite (node:sqlite), Pino logging, JSON HTTP client
  config/               Zod schemas for environment and user preferences
  utils/                Timeouts, concurrency, rate limiting, formatting, Stremio id parsing
  server.ts             HTTP routes: own pages and routes first, then the SDK router
  app.ts                Composition root
  index.ts              Entry point
tests/
  unit/                 Parser, ranking, dedupe, preferences, subtitles, caching, discovery, prober, providers, formatter
  integration/          Full addon with mocked providers: handlers, HTTP routes, companion failover
```

Request flow for a stream:

```
Stremio ─► /{config}/stream/movie/tt….json ─► SDK router ─► stream handler
   ─► StreamService.select
        ├─ MetadataService (Cinemeta/TMDB, cached 24 h)
        ├─ StreamDiscoveryService (all providers in parallel, per-provider timeout, cached 30 min)
        ├─ dedupe → preference filters → pre-rank
        ├─ StreamProber (top N HTTP links, cached 10 min)
        └─ rank (+ reliability history) → top maxResults
   ─► formatter (labels, bingeGroup, optional companion URLs) ─► JSON to Stremio
```

Express is not used: Node's `http` server plus the SDK's own router is enough.

## Adding a new provider

1. Create `src/providers/streams/my-source.ts` implementing `StreamProvider`:

   ```ts
   export class MySourceProvider implements StreamProvider {
     readonly id = 'my-source';
     readonly name = 'My Source';
     readonly peerToPeer = false;          // true if it can return torrents

     supports(media: MediaRequest) { return true; }

     async findStreams(media: MediaRequest, ctx: ProviderContext): Promise<StreamCandidate[]> {
       const items = await requestJson<MyApiResponse>(fetch, `https://api.example/…`, { signal: ctx.signal });
       return items.map((item) =>
         buildCandidate({
           providerId: this.id,
           providerName: this.name,
           transport: { kind: 'http', url: item.url },
           title: item.releaseName,
           sizeBytes: item.size,
         }),
       );
     }
   }
   ```

   `buildCandidate` parses resolution, codecs, source and group from names; pass structured values (resolution, codec) when the API has them. Always pass `ctx.signal` to network calls.

2. Register it in `src/providers/streams/index.ts` behind a `STREAM_PROVIDERS` name.
3. Add a unit test with a mocked `fetch` (see `tests/unit/providers.test.ts`).

Timeouts, caching, request de-duplication, error isolation, duplicate detection, testing and ranking apply automatically. Subtitle providers work the same way through `SubtitleProvider` (and `SubtitleFileSource` if files must be fetched lazily).

## Testing

```bash
npm test            # all tests
npm run typecheck   # strict TypeScript
```

All tests use mocked providers or local throw-away HTTP servers; none contact real streaming or subtitle services. Covered: ranking and every scorer, seeder saturation (the 2,000 vs 200 case), resolution and size preferences, profiles, duplicate detection and mirrors, preference validation, subtitle language order, release/hash/FPS matching and de-duplication, provider timeouts (including providers that ignore their abort signal), provider failures, caching (TTL, persistence, in-flight de-duplication, no caching of failures), reliability decay, HTTP probing, provider response normalization, Stremio stream/subtitle/manifest shape, the HTTP routes, and companion failover end to end.

## Known limitations

- **No mid-playback switching, no playback events, no forced subtitle selection.** These are Stremio limits, explained [above](#what-a-stremio-addon-can-and-cannot-control).
- **Tests run from the addon's network.** If the addon runs on a remote server, "answered a test request" and measured speeds describe the server's connection, not yours. Links bound to the requesting IP may also fail the test from a server while working for you. Run the addon locally for the most meaningful results.
- **Torrents cannot be tested** without joining the swarm. Their availability is shown as *unverified* and is based on provider-reported peers, which may be stale. Speed history for a torrent exists only if it was played through a path the addon can observe.
- **Probe speeds are short samples** (256 KB by default) and are noisy; they are used as one signal among several.
- **Internet Archive matching** is by title and year, movies only; its catalog is mostly older, public-domain and openly licensed films.
- **Seeders, sizes and codecs from upstream addons** are parsed from their text labels when not given as structured data, so unusual label formats may be missed.
- **OpenSubtitles quotas** apply to your API key/account. When exhausted, subtitle links return a clear error until the quota resets.
- **Original-language subtitles** need a TMDB key.
- `node:sqlite` is still flagged experimental by Node; the scripts suppress the warning. Setting `DATABASE_PATH=` (empty) disables persistence entirely.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Stremio refuses to install the addon | Remote installs need HTTPS. Use `http://127.0.0.1` only from the same computer. |
| No streams at all | Open `/status`. If providers show failures, check network access and `PROVIDER_TIMEOUT_MS`. If they answered but found nothing, the title is simply not in your sources (Internet Archive covers few modern films). |
| A single "⚠️ No streams" entry | Every provider failed or timed out; tap it to open `/status`. Results are cached briefly, so retry after a minute. |
| No subtitles listed | Set `OPENSUBTITLES_API_KEY`; the configure page shows whether subtitles are enabled. Check the log for `Subtitle provider failed`. |
| Subtitles listed but not shown | Set *Default subtitle language* in Stremio's player settings. |
| Subtitle out of sync | Pick the next one in the list; hash matches come first only when Stremio could compute the file hash. |
| "This stream link has expired" | Companion sessions last `COMPANION_SESSION_TTL_H` hours. Reopen the title. |
| Everything is slow to appear | Lower `PROBE_MAX_STREAMS` or `PROBE_TIMEOUT_MS`, or set `PROBE_ENABLED=false`. |
| Changes in `.env` ignored | Restart the server; `.env` is read at start. |
| Debugging | `LOG_LEVEL=debug` logs each provider call, probe and ranking decision as JSON. |

## License

MIT
