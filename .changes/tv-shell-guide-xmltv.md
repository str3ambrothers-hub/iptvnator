---
type: feature
area: tv-shell
---

Live TV guide: reads the provider's whole-guide file (xmltv.php) once in the background and fills channels from it instead of asking for each channel separately (switch: `guide-bulk`). Falls back to the old per-channel loading until the file is ready or if it fails.
