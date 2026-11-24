# StreamBros on Samsung TV (Tizen)

The same StreamBros app as on Fire TV, packaged for Samsung. Status:
**first build, not yet tried on a real TV.**

## How it differs from the Fire TV build

| Fire TV (Android) | Samsung (this folder) |
|---|---|
| Java backend on loopback calls the provider | `backend.js` answers the same `/api/*` calls inside the page and calls the provider directly (allowed by `<access origin="*">` in `config.xml`) |
| `MainActivity` / `TvShellBridge` handle Back, media keys, exit | `adapter.js` does the same for `tv.js`, which is unchanged |
| Native player (Media3) for movies and live TV | `player.js` on Samsung's **AVPlay**: same hand-over from `tv.js`, same keys (below). Without AVPlay, or with `tizen-avplay` off, the page's own player is used |
| Poster cache (`/api/image`) | Not yet: original posters (`poster-cache` forced off) |
| "Try another app" (VLC) | Not on Samsung: shows a message |
| Xtream, M3U, Stalker | **Xtream only** for now (M3U and Stalker answer 501) |

Kill switches (`localStorage`): `tizen-backend`, `tizen-keys`, `tizen-avplay`
(`'off'`), and `tizen-keep-switches` (`'on'` stops the adapter changing
`poster-cache`, `native-live` and `native-movies`).

### Built-in player keys (AVPlay)

| Key | Movies / episodes | Live TV |
|---|---|---|
| Back, Stop | close | close (focus returns to the channel in the guide) |
| OK | show the info bar; again: pause / play | same |
| Play/Pause | pause / play | same |
| Left / Right | 10 s back / forward | shows the bar |
| Rewind / Fast forward | 30 s back / forward | — |
| Up / Down | shows the bar | bar hidden: previous / next channel |
| Channel up / down | — | next / previous channel |

If AVPlay cannot play a stream, the player says so; Back returns to the app
(there is no "other app" fallback on Samsung).

## Getting the app

Every push to a `feat/tizen-*` branch runs GitHub Actions → **Build Samsung TV app**
(once it is on master, *Run workflow* with *create_release* works too). A passing
build runs the checks, builds the PWA and publishes an **unsigned** app folder:
`https://github.com/str3ambrothers-hub/iptvnator/releases/download/tizen-shell-latest/streambros-samsung.zip`

## Signing and installing (Windows PC, once per TV)

Samsung only installs an app signed with a certificate that lists that TV's
device ID (DUID). One certificate holds up to about 50 TVs, so a new client's
TV means adding its DUID and signing again.

1. Install **Tizen Studio** with the *Samsung TV Extension* and *Samsung
   Certificate Extension*. Put `tizen.bat` and `sdb.exe` on your PATH
   (they are in `C:\tizen-studio\tools\ide\bin` and `C:\tizen-studio\tools`).
2. On the TV: **Apps**, press `1 2 3 4 5`, turn **Developer mode** on, type
   your PC's IP address, restart the TV.
3. On the PC (same network): `sdb connect <tv-ip>:26101`, then
   `sdb devices` shows the TV.
4. In Tizen Studio, **Certificate Manager** → new **Samsung** profile → TV →
   sign in with your Samsung account → add the TV's DUID (it is listed when the
   TV is connected). Keep this profile backed up and **never put it in Git**.
5. Unzip `streambros-samsung.zip` to a folder, e.g. `C:\streambros\app`, then:

   ```bat
   tizen package -t wgt -s <your-profile> -- C:\streambros\app
   tizen install -s <tv-ip>:26101 -n StreamBros.wgt -- C:\streambros\app
   ```

   (If the .wgt gets another name, use the name `tizen package` printed.)

**StreamBros** then appears under Apps. To update, repeat step 5; logins and
settings stay on the TV.

## What is NOT verified yet (check on the first TV)

- That provider calls really work from the TV with no proxy (the whole design rests on it).
- Which TV years can run the app at all. The Angular build targets modern
  Chromium; TVs from before about 2022 have an older engine and may show a
  blank screen. Note the TV's model year and Tizen version.
- Remote: arrows, OK, Back, Tools, Play/Pause; Back twice exits.
- AVPlay: picture shows full screen (not just sound), live TV (MPEG-TS and
  HLS), movies (MP4/MKV, AC3 sound), seeking, channel up/down from the guide,
  and Home → back into the app while playing (suspend/restore).
- Login, catalogue of 30–50k items (memory), guide, backup server.
