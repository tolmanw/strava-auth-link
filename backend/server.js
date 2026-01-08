// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "https://tolmanw.github.io" })); // allow your frontend only

// Local JSON path
const TOKENS_FILE = path.join(__dirname, "tokens.json"); // matches your GitHub file

// --- Push tokens.json to GitHub ---
async function pushTokensToGitHub() {
    const repo = process.env.GITHUB_REPO; // e.g., "tolmanw/strava-refresh-tokens"
    const branch = process.env.GITHUB_BRANCH || "main";
    const token = process.env.GITHUB_TOKEN;

    if (!fs.existsSync(TOKENS_FILE)) return;

    const data = fs.readFileSync(TOKENS_FILE, "utf8");
    const content = Buffer.from(data).toString("base64");

    // Get SHA if file already exists
    const urlGet = `https://api.github.com/repos/${repo}/contents/tokens.json?ref=${branch}`;
    let sha;
    try {
        const resp = await fetch(urlGet, {
            headers: { Authorization: `token ${token}`, "User-Agent": "node.js" }
        });
        if (resp.status === 200) {
            const json = await resp.json();
            sha = json.sha;
        }
    } catch (err) {
        console.log("tokens.json does not exist on GitHub yet; it will be created.");
    }

    // PUT to create/update
    const urlPut = `https://api.github.com/repos/${repo}/contents/tokens.json`;
    const body = { message: "Update refresh tokens", content, branch };
    if (sha) body.sha = sha;

    const resp = await fetch(urlPut, {
        method: "PUT",
        headers: { Authorization: `token ${token}`, "User-Agent": "node.js" },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const text = await resp.text();
        console.error("GitHub error:", text);
    } else {
        console.log("tokens.json pushed to GitHub successfully.");
    }
}

// --- Save refresh token per athleteId ---
function saveRefreshToken(athleteId, name, token) {
    let data = {};
    if (fs.existsSync(TOKENS_FILE)) {
        data = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    }
    data[athleteId] = { name, refresh_token: token };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
    console.log(`Saved refresh token for athlete ${athleteId} (${name})`);

    pushTokensToGitHub().catch(err => console.error("GitHub push failed:", err));
}

// --- Exchange Strava auth code ---
app.get("/exchange-code", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).json({ message: "No code provided" });

    try {
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

        const profileResp = await fetch("https://www.strava.com/api/v3/athlete", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const profileData = await profileResp.json();

        const athleteId = profileData.id.toString();
        const name = profileData.firstname && profileData.lastname
            ? `${profileData.firstname} ${profileData.lastname}`
            : "Unknown Athlete";

        saveRefreshToken(athleteId, name, refreshToken);

        res.json({ refresh_token: refreshToken, name, athleteId });
    } catch (err) {
        console.error("Exchange error:", err);
        res.status(500).json({ message: "Server error: " + err.message });
    }
});

// --- Protected /tokens route ---
function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
        return res.status(401).send("Authentication required.");
    }
    const [username, password] = Buffer.from(authHeader.split(" ")[1], "base64").toString("ascii").split(":");
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).send("Invalid credentials.");
}

app.get("/tokens", basicAuth, (req, res) => {
    if (fs.existsSync(TOKENS_FILE)) {
        res.json(JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")));
    } else {
        res.json({});
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
