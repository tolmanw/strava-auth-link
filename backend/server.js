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

// Allow frontend to communicate
app.use(cors({
  origin: process.env.FRONTEND_URL || "*" 
}));

// Path to store refresh tokens
const TOKENS_FILE = path.join(__dirname, "refresh_tokens.json");

// --- Helper: Save refresh token using athlete ID as key ---
function saveRefreshToken(athleteId, name, token) {
    let data = {};
    if (fs.existsSync(TOKENS_FILE)) {
        const raw = fs.readFileSync(TOKENS_FILE);
        data = JSON.parse(raw);
    }
    data[athleteId] = { name, refresh_token: token, timestamp: new Date().toISOString() };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
    console.log(`Saved refresh token for athlete ${athleteId} (${name})`);
}

// --- Helper: Send email via Resend ---
async function sendEmailNotification(name, athleteId) {
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) return;
    try {
        const emailResp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                from: process.env.RESEND_FROM_EMAIL,
                to: process.env.RESEND_FROM_EMAIL,
                subject: `New Strava Refresh Token: ${name}`,
                html: `<p>Athlete: ${name} (${athleteId})</p><p>Token saved on ${new Date().toLocaleString()}</p>`
            })
        });
        console.log("Email sent:", await emailResp.json());
    } catch (err) {
        console.error("Failed to send email:", err);
    }
}

// --- Basic Auth Middleware for /tokens ---
function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
        return res.status(401).send("Authentication required.");
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        return next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
        return res.status(401).send("Invalid credentials.");
    }
}

// --- Route: Exchange Strava auth code for refresh token ---
app.get("/exchange-code", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).json({ message: "No code provided" });

    try {
        // Step 1: Exchange code for tokens
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
        if (!tokenData.refresh_token) {
            return res.status(400).json({ message: tokenData.message || "Failed to get refresh token" });
        }

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;

        // Step 2: Fetch athlete profile for ID and name
        const profileResp = await fetch("https://www.strava.com/api/v3/athlete", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const profileData = await profileResp.json();
        const athleteId = profileData.id.toString();
        const name = profileData.firstname && profileData.lastname
            ? `${profileData.firstname} ${profileData.lastname}`
            : "Unknown Athlete";

        // Step 3: Save token and send notification email
        saveRefreshToken(athleteId, name, refreshToken);
        await sendEmailNotification(name, athleteId);

        // Step 4: Respond with refresh token and name
        res.json({ refresh_token: refreshToken, name, athleteId });

    } catch (err) {
        console.error("Exchange error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// --- Protected route to list all saved tokens ---
app.get("/tokens", basicAuth, (req, res) => {
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
