const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const PRIVATE_COOKIE_NAME = "spotify_lab_session";
const PRIVATE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;
const PRIVATE_COOKIE_MAX_AGE_MS = PRIVATE_COOKIE_MAX_AGE_SECONDS * 1000;

const requiredBaseEnv = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REDIRECT_URI"];
const missingBaseEnv = requiredBaseEnv.filter((key) => !process.env[key]);

if (missingBaseEnv.length) {
    console.warn(`Missing required env vars: ${missingBaseEnv.join(", ")}`);
}

app.use(express.json());

function parseCookies(req) {
    const cookieHeader = req.headers.cookie || "";
    return cookieHeader.split(";").reduce((acc, rawCookie) => {
        const trimmed = rawCookie.trim();
        if (!trimmed) return acc;
        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex <= 0) return acc;
        const key = trimmed.slice(0, separatorIndex);
        const value = decodeURIComponent(trimmed.slice(separatorIndex + 1));
        acc[key] = value;
        return acc;
    }, {});
}

function timingSafeEqualString(a, b) {
    const aBuffer = Buffer.from(String(a));
    const bBuffer = Buffer.from(String(b));
    if (aBuffer.length !== bBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function signSessionPayload(payload) {
    const sessionSecret =
        process.env.PRIVATE_TAB_SECRET || process.env.SPOTIFY_CLIENT_SECRET || "change-me-private-session-secret";
    return crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
}

function createPrivateSessionToken() {
    const expiresAt = Date.now() + PRIVATE_COOKIE_MAX_AGE_MS;
    const payload = String(expiresAt);
    const signature = signSessionPayload(payload);
    return `${payload}.${signature}`;
}

function isValidPrivateSessionToken(token) {
    if (!token || typeof token !== "string") {
        return false;
    }
    const [payload, signature] = token.split(".");
    if (!payload || !signature) {
        return false;
    }
    const expectedSignature = signSessionPayload(payload);
    if (!timingSafeEqualString(signature, expectedSignature)) {
        return false;
    }
    const expiresAt = Number(payload);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function isPrivateAuthorized(req) {
    const cookies = parseCookies(req);
    return isValidPrivateSessionToken(cookies[PRIVATE_COOKIE_NAME]);
}

function hasValidPrivatePassword(req) {
    const configuredPassword = process.env.PRIVATE_TAB_PASSWORD;
    if (!configuredPassword) {
        return false;
    }
    const providedPassword = req.headers["x-private-password"];
    return timingSafeEqualString(providedPassword || "", configuredPassword);
}

function requirePrivateAuth(req, res, next) {
    if (!isPrivateAuthorized(req) && !hasValidPrivatePassword(req)) {
        return res.status(401).json({ error: "Unauthorized." });
    }
    return next();
}

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

function createAuthCookieValue(token, isSecure) {
    return [
        `${PRIVATE_COOKIE_NAME}=${encodeURIComponent(token)}`,
        `Max-Age=${PRIVATE_COOKIE_MAX_AGE_SECONDS}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        isSecure ? "Secure" : ""
    ]
        .filter(Boolean)
        .join("; ");
}

function createExpiredAuthCookieValue(isSecure) {
    return [
        `${PRIVATE_COOKIE_NAME}=`,
        "Max-Age=0",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        isSecure ? "Secure" : ""
    ]
        .filter(Boolean)
        .join("; ");
}

async function getTopArtistsFromRecentHistory(accessToken, sinceDate, maxRequests = 40) {
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

        const nextBeforeMs = oldestPlayedAtMs - 1;
        if (beforeMs !== null && nextBeforeMs >= beforeMs) {
            break;
        }

        beforeMs = nextBeforeMs;
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

app.post("/api/private/login", (req, res) => {
    const configuredPassword = process.env.PRIVATE_TAB_PASSWORD;
    if (!configuredPassword) {
        return res.status(503).json({ error: "Private tab password is not configured." });
    }

    const incomingPassword = req.body?.password;
    if (!timingSafeEqualString(incomingPassword || "", configuredPassword)) {
        return res.status(401).json({ error: "Invalid password." });
    }

    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    const token = createPrivateSessionToken();
    res.setHeader("Set-Cookie", createAuthCookieValue(token, isSecure));
    return res.json({ authenticated: true });
});

app.post("/api/private/logout", (req, res) => {
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie", createExpiredAuthCookieValue(isSecure));
    return res.json({ authenticated: false });
});

app.get("/api/private/session", (req, res) => {
    return res.json({ authenticated: isPrivateAuthorized(req) });
});

app.get("/api/spotify/private/stats", requirePrivateAuth, async (req, res) => {
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

        return res.json({
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
});

app.get("/spotify-lab", (req, res) => {
    if (!isPrivateAuthorized(req)) {
        return res.sendFile(path.join(__dirname, "spotify-lab.html"));
    }
    return res.sendFile(path.join(__dirname, "spotify-lab.html"));
});

app.get("/spotify-lab.html", (req, res) => {
    return res.redirect("/spotify-lab");
});

app.use(express.static(path.join(__dirname)));

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
