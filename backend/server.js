// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");
require("dotenv").config();

// node-fetch for CommonJS
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for your frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || "*"
}));

// Local backup path
const TOKENS_FILE = path.join(__dirname, process.env.DATA_FILE || "tokens.json");

// --- GitHub setup ---
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const repoOwner = process.env.GITHUB_USERNAME;
const repoName = process.env.DATA_REPO;
const repoFilePath = process.env.DATA_FILE || "tokens.json";
const branch = "main"; // adjust if needed

// --- Save tokens locally and push to GitHub ---
async function pushTokensToGitHub(data) {
    try {
        // Check if file exists in GitHub
        let sha;
        try {
            const resp = await octokit.repos.getContent({
                owner: repoOwner,
                repo: repoName,
                path: repoFilePath,
                ref: branch
            });
            sha = resp.data.sha; // required for update
        } catch (err) {
            if (err.status !== 404) throw err; // only ignore if not found
        }

        await octokit.repos.createOrUpdateFileContents({
            owner: repoOwner,
            repo: repoName,
            path: repoFilePath,
            message: `Update tokens.json`,
            content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
            branch,
            sha
        });
        console.log("Tokens.json pushed to GitHub successfully.");
    } catch (err) {
        console.error("GitHub error:", err);
    }
}

// --- Save refresh token locally + GitHub ---
async function saveRefreshToken(athleteId, name, token) {
    let data = {};
    if (fs.existsSync(TOKENS_FILE)) {
        const raw = fs.readFileSync(TOKENS_FILE);
        data = JSON.parse(raw);
    }

    data[athleteId] = { name, refresh_token: token };

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
    console.log(`Saved refresh token for athlete ${athleteId} (${name})`);

    // Push to GitHub
    await pushTokensToGitHub(data);
}

// --- Basic Auth for /tokens ---
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

// --- Exchange Strava code for tokens ---
app.get("/exchange-code", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).json({ message: "No code provided" });

    try {
        // Exchange code for access + refresh tokens
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

        // Fetch athlete profile
        const profileResp = await fetch("https://www.strava.com/api/v3/athlete", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const profileData = await profileResp.json();
        const athleteId = profileData.id.toString();
        const name = profileData.firstname && profileData.lastname
            ? `${profileData.firstname} ${profileData.lastname}`
            : "Unknown Athlete";

        // Save locally + GitHub
        await saveRefreshToken(athleteId, name, refreshToken);

        res.json({ refresh_token: refreshToken, name, athleteId });

    } catch (err) {
        console.error("Exchange error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// --- Protected route to view tokens ---
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
