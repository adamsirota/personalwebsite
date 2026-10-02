/* Adam Sirota — site behaviour.
   Theme is resolved by a blocking script in <head>; this only handles the
   toggle, the nav's current-section state, and the Spotify panel. */

(function () {
    "use strict";

    /* --- Theme toggle --------------------------------------------------- */

    const root = document.documentElement;
    const toggle = document.getElementById("theme-toggle");

    const syncToggleLabel = () => {
        const isDark = root.getAttribute("data-theme") === "dark";
        toggle.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
    };

    if (toggle) {
        syncToggleLabel();
        toggle.addEventListener("click", () => {
            const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
            root.setAttribute("data-theme", next);
            syncToggleLabel();
            try {
                localStorage.setItem("theme", next);
            } catch (err) {
                /* private mode — the choice just won't persist */
            }
        });
    }

    /* --- Current section in the nav ------------------------------------- */

    const navLinks = Array.from(document.querySelectorAll(".masthead__nav a[href^='#']"));

    if (navLinks.length && "IntersectionObserver" in window) {
        const sections = navLinks
            .map((link) => document.querySelector(link.getAttribute("href")))
            .filter(Boolean);

        const setCurrent = (id) => {
            navLinks.forEach((link) => {
                if (link.getAttribute("href") === `#${id}`) {
                    link.setAttribute("aria-current", "true");
                } else {
                    link.removeAttribute("aria-current");
                }
            });
        };

        const visible = new Set();

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        visible.add(entry.target.id);
                    } else {
                        visible.delete(entry.target.id);
                    }
                });

                // Topmost visible section wins, so the marker never flickers
                // between two sections straddling the viewport.
                const current = sections.find((section) => visible.has(section.id));
                if (current) {
                    setCurrent(current.id);
                } else {
                    setCurrent(null);
                }
            },
            { rootMargin: "-20% 0px -60% 0px" }
        );

        sections.forEach((section) => observer.observe(section));
    }

    /* --- Spotify -------------------------------------------------------- */

    const lastPlayedEl = document.getElementById("spotify-last-played");
    const topArtistsEl = document.getElementById("spotify-top-artists");

    if (!lastPlayedEl || !topArtistsEl) return;

    const externalLink = (text, href) => {
        const anchor = document.createElement("a");
        anchor.textContent = text;
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        return anchor;
    };

    const renderLastPlayed = (lastPlayed) => {
        lastPlayedEl.textContent = "";

        if (!lastPlayed || !lastPlayed.track || !lastPlayed.artist) {
            lastPlayedEl.textContent = "No recent plays to show.";
            return;
        }

        const title = lastPlayed.url
            ? externalLink(lastPlayed.track, lastPlayed.url)
            : document.createTextNode(lastPlayed.track);

        lastPlayedEl.append(title, ` — ${lastPlayed.artist}`);

        if (lastPlayed.playedAt) {
            const when = new Date(lastPlayed.playedAt);
            if (!Number.isNaN(when.valueOf())) {
                const stamp = document.createElement("span");
                stamp.className = "spotify__when mono";
                stamp.textContent = ` ${when.toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short"
                })}`;
                lastPlayedEl.append(stamp);
            }
        }
    };

    const renderArtists = (artists) => {
        topArtistsEl.textContent = "";

        if (!artists.length) {
            const item = document.createElement("li");
            item.textContent = "No artist data available.";
            topArtistsEl.append(item);
            return;
        }

        artists.forEach((artist) => {
            const item = document.createElement("li");
            item.append(artist.url ? externalLink(artist.name, artist.url) : artist.name);
            topArtistsEl.append(item);
        });
    };

    const renderUnavailable = () => {
        lastPlayedEl.textContent = "Spotify is not reachable right now.";
        topArtistsEl.textContent = "";
    };

    fetch("/api/spotify/stats")
        .then((response) => {
            if (!response.ok) throw new Error(`Spotify request failed: ${response.status}`);
            return response.json();
        })
        .then((data) => {
            renderLastPlayed(data.lastPlayed);
            renderArtists(Array.isArray(data.topArtists) ? data.topArtists.slice(0, 3) : []);
        })
        .catch(renderUnavailable);
})();
