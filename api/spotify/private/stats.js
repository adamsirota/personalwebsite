const SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

async function spotifyTokenRequest(params) {
    const credentials = Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");

    const response = await fetch(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(params).toString()
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Spotify token request failed (${response.status}): ${body}`);
    }

    return response.json();
}

async function spotifyApiGet(endpoint, accessToken) {
    const response = await fetch(`${SPOTIFY_API_BASE}${endpoint}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Spotify API request failed (${response.status}): ${body}`);
    }

    return response.json();
}

function isPasswordValid(req) {
    const configuredPassword = process.env.PRIVATE_TAB_PASSWORD;
    const providedPassword = req.headers["x-private-password"];
    return Boolean(configuredPassword) && providedPassword === configuredPassword;
}

async function getTopArtistsFromRecentHistory(accessToken, sinceDate, maxRequests = 20) {
    const artistCounts = new Map();
    let beforeMs = null;
    let requestCount = 0;

    while (requestCount < maxRequests) {
        const query = new URLSearchParams({ limit: "50" });
        if (beforeMs !== null) {
            query.set("before", String(beforeMs));
        }

        const history = await spotifyApiGet(`/me/player/recently-played?${query.toString()}`, accessToken);
        const items = Array.isArray(history.items) ? history.items : [];
        if (!items.length) {
            break;
        }

        for (const item of items) {
            const playedAtMs = Date.parse(item.played_at || "");
            if (!Number.isFinite(playedAtMs) || playedAtMs < sinceDate.getTime()) {
                continue;
            }

            const trackArtists = Array.isArray(item.track?.artists) ? item.track.artists : [];
            for (const artist of trackArtists) {
                const key = artist.id || artist.name;
                if (!key) continue;

                const existing = artistCounts.get(key);
                if (existing) {
                    existing.plays += 1;
                } else {
                    artistCounts.set(key, {
                        name: artist.name || "Unknown artist",
                        url: artist.external_urls?.spotify || "",
                        plays: 1
                    });
                }
            }
        }

        const oldestPlayedAtMs = Date.parse(items[items.length - 1]?.played_at || "");
        if (!Number.isFinite(oldestPlayedAtMs) || oldestPlayedAtMs < sinceDate.getTime()) {
            break;
        }

        beforeMs = oldestPlayedAtMs - 1;
        requestCount += 1;
    }

    return Array.from(artistCounts.values())
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 20)
        .map((artist) => ({
            name: artist.name,
            url: artist.url,
            plays: artist.plays
        }));
}

module.exports = async (req, res) => {
    if (!isPasswordValid(req)) {
        return res.status(401).json({ error: "Unauthorized." });
    }

    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET || !process.env.SPOTIFY_REFRESH_TOKEN) {
        return res.status(503).json({
            error: "Missing Spotify environment variables."
        });
    }

    try {
        const tokenData = await spotifyTokenRequest({
            grant_type: "refresh_token",
            refresh_token: process.env.SPOTIFY_REFRESH_TOKEN
        });
        const accessToken = tokenData.access_token;

        const [fourWeeksData, sixMonthsData, weekArtists, yearToDateArtists] = await Promise.all([
            spotifyApiGet("/me/top/artists?time_range=short_term&limit=20", accessToken),
            spotifyApiGet("/me/top/artists?time_range=medium_term&limit=20", accessToken),
            getTopArtistsFromRecentHistory(accessToken, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
            getTopArtistsFromRecentHistory(accessToken, new Date(new Date().getFullYear(), 0, 1))
        ]);

        const fourWeekArtists = (fourWeeksData.items || []).slice(0, 20).map((artist) => ({
            name: artist.name,
            url: artist.external_urls?.spotify || ""
        }));

        const sixMonthArtists = (sixMonthsData.items || []).slice(0, 20).map((artist) => ({
            name: artist.name,
            url: artist.external_urls?.spotify || ""
        }));

        return res.status(200).json({
            ranges: {
                week: weekArtists.length
                    ? { label: "Past week", source: "recently-played", artists: weekArtists }
                    : { label: "Past week", source: "spotify-short-term-fallback", artists: fourWeekArtists },
                fourWeeks: { label: "Past 4 weeks", source: "spotify-short-term", artists: fourWeekArtists },
                sixMonths: { label: "Past 6 months", source: "spotify-medium-term", artists: sixMonthArtists },
                yearToDate: {
                    label: "Since Jan 1",
                    source: "recently-played",
                    since: new Date(new Date().getFullYear(), 0, 1).toISOString(),
                    artists: yearToDateArtists
                }
            }
        });
    } catch (err) {
        return res.status(500).json({ error: "Failed to load private Spotify stats.", detail: err.message });
    }
};
