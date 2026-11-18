---
type: fix
area: tv-shell
---

On Android TV and Fire TV, the built-in player now retries a movie that fails to read (a provider refusing a second connection or answering a seek wrongly) up to twice, and releases the page's own download of the movie before it starts.
