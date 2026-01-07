// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// node-fetch v3 CommonJS import
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your frontend (GitHub Pages) to call the backend
app.use(cors({
  origin: "https://tolmanw.github.io"
}));

// Path to store refresh tokens
const TOKENS_FILE = path.join(__dirname, "refresh_tokens.json");

// Helper to save refresh token with athlete ID
function saveRefreshToken(athleteId, name, token) {
    let data = {};

    // Load existing JSON if it exists
    if (fs.existsSync(TOKENS_FILE)) {
        const raw = fs.readFileSync(TOKENS_FILE);
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.warn("Failed to parse JSON, starting fresh");
            data = {};
        }
    }

    // Add or update this athlete
    data[athleteId] = { name, refresh_token: token };

    // Save back to disk
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
    console.log(`Saved refresh token for athlete ${athleteId} (${name})`);
}

// Route to exchange Strava auth code for refresh token
app.get("/exchange-code", async (req, res) => {
    const code = req.query.code;

    if (!code) return res.status(400).json({ message: "No code provided" });

    try {
        // Exchange code for tokens
        const tokenResp = await fetch("https://www.strava.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: process.env.STRAVA_CLIENT_ID,
                client_secret: process.env.STRAVA_CLIENT_SECRET,
                code,
                grant_type: "authorization_code"
            })
        });

        const tokenData = await tokenResp.json();
        console.log("Strava token response:", tokenData);

        if (!tokenData.refresh_token || !tokenData.athlete?.id) {
            return res.status(400).json({ message: tokenData.message || "Failed to get refresh token" });
        }

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const athleteId = tokenData.athlete.id;

        // Fetch user profile (optional, to store name)
        const profileResp = await fetch("https://www.strava.com/api/v3/athlete", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const profileData = await profileResp.json();
        const name = profileData.firstname && profileData.lastname
            ? `${profileData.firstname} ${profileData.lastname}`
            : "Unknown Athlete";

        // Save athlete ID + name + refresh token
        saveRefreshToken(athleteId, name, refreshToken);

        res.json({ refresh_token: refreshToken, name, athleteId });

    } catch (err) {
        console.error("Exchange error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// Restricted /tokens endpoint (replace ADMIN_ID with your Strava athlete ID)
const ADMIN_ATHLETE_ID = 12345678; // <-- put your own Strava athlete ID here
app.get("/tokens", (req, res) => {
    const requesterId = parseInt(req.query.athleteId);
    if (requesterId !== ADMIN_ATHLETE_ID) {
        return res.status(403).json({ message: "Forbidden: You cannot view tokens" });
    }

    if (fs.existsSync(TOKENS_FILE)) {
        const data = fs.readFileSync(TOKENS_FILE);
        res.json(JSON.parse(data));
    } else {
        res.json({});
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
