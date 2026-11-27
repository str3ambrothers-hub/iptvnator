---
type: fix
area: tv-shell
---

Live TV guide: "Only with EPG" now works when it is on by default (the scan that finds channels without a guide never started), and channels whose id is missing from the provider's guide file are matched by name (switches: `guide-bulk-names`).
