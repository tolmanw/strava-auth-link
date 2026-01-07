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

app.use(cors());

// Path to store refresh tokens
const TOKENS_FILE = path.join(__dirname, "refresh_tokens.json");

// Helper to save refresh token with user name
function saveRefreshToken(userId, name, token) {
    let data = {};
    if (fs.existsSync(TOKENS_FILE)) {
        const raw = fs.readFileSync(TOKENS_FILE);
        data = JSON.parse(raw);
    }
    data[userId] = { name, refresh_token: token };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
    console.log(`Saved refresh token for user ${userId} (${name})`);
}

// Route to exchange Strava auth code for refresh token
app.get("/exchange-code", async (req, res) => {
    const code = req.query.code;
    const userId = req.query.userId || "default_user";

    if (!code) return res.status(400).json({ message: "No code provided" });

    try {
        console.log(`Exchanging code for user: ${userId}`);

        // Step 1: Exchange code for access + refresh tokens
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

        if (!tokenData.refresh_token) {
            return res.status(400).json({ message: tokenData.message || "Failed to get refresh token" });
        }

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;

        // Step 2: Fetch user profile to get name
        const profileResp = await fetch("https://www.strava.com/api/v3/athlete", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const profileData = await profileResp.json();
        const name = `${profileData.firstname} ${profileData.lastname}`;

        // Step 3: Save user name + refresh token
        saveRefreshToken(userId, name, refreshToken);

        res.json({ refresh_token: refreshToken, name });
    } catch (err) {
        console.error("Exchange error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// Optional: Route to list saved tokens (for testing)
app.get("/tokens", (req, res) => {
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
