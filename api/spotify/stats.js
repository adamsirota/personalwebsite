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

module.exports = async (req, res) => {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET || !process.env.SPOTIFY_REFRESH_TOKEN) {
        return res.status(503).json({
            error: "Missing Spotify environment variables in Vercel."
        });
    }

    try {
        const tokenData = await spotifyTokenRequest({
            grant_type: "refresh_token",
            refresh_token: process.env.SPOTIFY_REFRESH_TOKEN
        });

        const accessToken = tokenData.access_token;
        const [topArtistsData, recentlyPlayedData] = await Promise.all([
            spotifyApiGet("/me/top/artists?time_range=short_term&limit=3", accessToken),
            spotifyApiGet("/me/player/recently-played?limit=1", accessToken)
        ]);

        const topArtists = (topArtistsData.items || []).slice(0, 3).map((artist) => ({
            name: artist.name,
            url: artist.external_urls?.spotify || ""
        }));

        const lastPlayedItem = recentlyPlayedData.items?.[0];
        const lastTrack = lastPlayedItem?.track;
        const lastPlayed = lastTrack
            ? {
                  track: lastTrack.name,
                  artist: (lastTrack.artists || []).map((a) => a.name).join(", "),
                  url: lastTrack.external_urls?.spotify || "",
                  playedAt: lastPlayedItem.played_at || null
              }
            : null;

        return res.status(200).json({ topArtists, lastPlayed });
    } catch (err) {
        return res.status(500).json({ error: "Failed to load Spotify stats.", detail: err.message });
    }
};
