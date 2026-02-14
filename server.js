const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

const requiredBaseEnv = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REDIRECT_URI"];
const missingBaseEnv = requiredBaseEnv.filter((key) => !process.env[key]);

if (missingBaseEnv.length) {
    console.warn(`Missing required env vars: ${missingBaseEnv.join(", ")}`);
}

app.use(express.static(path.join(__dirname)));

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

app.get("/auth/spotify/login", (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.SPOTIFY_CLIENT_ID || "",
        response_type: "code",
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI || "",
        scope: "user-top-read user-read-recently-played"
    });

    res.redirect(`${SPOTIFY_ACCOUNTS_BASE}/authorize?${params.toString()}`);
});

app.get("/auth/spotify/callback", async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        return res.status(400).send(`Spotify auth error: ${error}`);
    }

    if (!code) {
        return res.status(400).send("Missing authorization code.");
    }

    try {
        const tokenData = await spotifyTokenRequest({
            grant_type: "authorization_code",
            code,
            redirect_uri: process.env.SPOTIFY_REDIRECT_URI
        });

        if (!tokenData.refresh_token) {
            return res.status(500).send("No refresh token returned. Re-authorize and ensure consent was granted.");
        }

        return res.send(
            `<h2>Spotify connected.</h2><p>Copy this into your .env as <code>SPOTIFY_REFRESH_TOKEN</code>:</p><pre>${tokenData.refresh_token}</pre>`
        );
    } catch (err) {
        return res.status(500).send(`Failed to exchange code: ${err.message}`);
    }
});

app.get("/api/spotify/stats", async (req, res) => {
    if (!process.env.SPOTIFY_REFRESH_TOKEN) {
        return res.status(503).json({
            error: "Spotify refresh token not configured. Complete /auth/spotify/login first."
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

        return res.json({ topArtists, lastPlayed });
    } catch (err) {
        return res.status(500).json({ error: "Failed to load Spotify stats.", detail: err.message });
    }
});

const useHttps = process.env.USE_HTTPS === "true";
const sslKeyPath = process.env.SSL_KEY_PATH;
const sslCertPath = process.env.SSL_CERT_PATH;

if (useHttps) {
    if (!sslKeyPath || !sslCertPath) {
        throw new Error("USE_HTTPS=true requires SSL_KEY_PATH and SSL_CERT_PATH.");
    }

    const httpsOptions = {
        key: fs.readFileSync(path.resolve(sslKeyPath)),
        cert: fs.readFileSync(path.resolve(sslCertPath))
    };

    https.createServer(httpsOptions, app).listen(PORT, () => {
        console.log(`Server running at https://localhost:${PORT}`);
    });
} else {
    http.createServer(app).listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}
