---
type: fix
area: tv-shell
---

On Android TV and Fire TV, a movie or episode opens in the built-in player without the page's own player showing first, the page's download of it is released, and the built-in player has an on-screen Back button next to its playback controls.

A movie's details screen also asks the provider a second time when the first answer comes back empty, so "Portal metadata unavailable" shows less often.

The built-in player starts sooner, decodes no more picture than the screen shows, seeks to the nearest keyframe, and the hidden page's timers are paused while it plays.
