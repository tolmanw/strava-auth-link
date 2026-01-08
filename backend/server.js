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

// Allow your frontend origin only
app.use(cors({
  origin: process.env.FRONTEND_URL || "*"
}));

// Path to store refresh tokens locally
const TOKENS_FILE = path.join(__dirname, "refresh_tokens.json");

// --- Helper to save refresh token with athlete ID as key ---
async function saveRefreshToken(athleteId, name, token) {
  let data = {};
  if (fs.existsSync(TOKENS_FILE)) {
    const raw = fs.readFileSync(TOKENS_FILE);
    data = JSON.parse(raw);
  }

  // Save athlete info
  data[athleteId] = { name, refresh_token: token };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
  console.log(`Saved refresh token for athlete ${athleteId} (${name})`);

  // Push to GitHub
  if (process.env.GITHUB_TOKEN && process.env.DATA_REPO && process.env.DATA_FILE) {
    try {
      await pushTokensToGitHub();
    } catch (err) {
      console.error("GitHub push failed:", err);
    }
  }
}

// --- Push local JSON to GitHub repo ---
async function pushTokensToGitHub() {
  const content = fs.readFileSync(TOKENS_FILE, "utf-8");
  const filePath = process.env.DATA_FILE; // e.g., "tokens.json"
  const repo = process.env.DATA_REPO;     // e.g., "username/strava-auth-data"
  const token = process.env.GITHUB_TOKEN;

  let sha;

  // Check if file exists to get sha
  try {
    const getResp = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "Strava-Auth-Bot"
      }
    });
    if (getResp.ok) {
      const data = await getResp.json();
      sha = data.sha;
    }
  } catch {
    console.log("GitHub file not found, will create a new one.");
  }

  // PUT request to create/update file
  const pushResp = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      "User-Agent": "Strava-Auth-Bot"
    },
    body: JSON.stringify({
      message: "Update Strava tokens",
      content: Buffer.from(content).toString("base64"),
      sha: sha // include sha if updating
    })
  });

  const pushData = await pushResp.json();
  if (!pushResp.ok) {
    throw new Error(`GitHub error: ${pushData.message || pushResp.status}`);
  }
  console.log("GitHub push succeeded:", pushData.content.path);
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

// --- Exchange Strava auth code for tokens ---
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

    // Get athlete profile
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

// --- Protected route to view all saved tokens ---
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
