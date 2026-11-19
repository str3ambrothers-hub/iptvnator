---
type: feature
area: tv-shell
---

Movies and Series in the TV app now start with Streaming categories (Netflix, Disney+, Prime Video, Apple TV+, Max or Crave, Paramount+, Hulu and Peacock, covering the US and Canada) built from TMDB lists bundled into the app, with no key or extra setup on the device. A title can be in a service category and in its usual category at once. Switch off with `localStorage['streaming-groups'] = 'off'`.

Opening a streaming service also lists its genres (the provider's own categories, narrowed to that service's titles) right below it; picking a genre shows those titles.

The category list now shows only "All items" and the streaming services at the top level, with an "Other categories" entry that reveals the provider's own categories. Opening a service shows only its genres, with an entry back to all platforms.
