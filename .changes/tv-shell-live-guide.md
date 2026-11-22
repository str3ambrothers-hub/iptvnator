---
type: feature
area: tv-shell
---

Live TV in the TV app now plays in the built-in player, with channel up/down to change channel, and the Live screen opens as a programme guide (channel numbers and names down the left, the next few hours of programmes across) instead of the channel list. Switch off with `localStorage['native-live'] = 'off'` and `localStorage['tv-guide'] = 'off'`.

In the programme guide the selection box and the guide's own selection no longer drift apart: the guide moves its own selection with the arrows, and the remote layer only takes over at its edges (to reach the side rail or the toolbar). Switch off with `localStorage['guide-own-keys'] = 'off'`.
