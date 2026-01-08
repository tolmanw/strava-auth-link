// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { Octokit } = require("@octokit/rest");

// node-fetch v3 CommonJS import
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.FRONTEND_URL || "*" // allow your frontend
}));

// Path to store local JSON temporarily (optional)
const DATA_FILE = path.join(__dirname, process.env.DATA_FILE || "tokens.json");

// GitHub Octokit client
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

// --- Helper: save token locally ---
function saveLocalToken(athleteId, name, token) {
  let data = {};
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE));
  }
  data[athleteId] = { name, refresh_token: token };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`Saved locally: ${athleteId} (${name})`);
}

// --- Helper: push token to GitHub asynchronously ---
async function pushTokenToGitHub(athleteId, name, token) {
  const repo = process.env.DATA_REPO; // e.g., "username/private-repo"
  const pathInRepo = process.env.DATA_FILE || "tokens.json";
  let sha;

  // Get current file SHA if it exists
  try {
    const resp = await octokit.repos.getContent({
      owner: repo.split("/")[0],
      repo: repo.split("/")[1],
      path: pathInRepo,
      ref: "main"
    });
    sha = resp.data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
    console.log("File does not exist yet in GitHub, creating new.");
  }

  // Read local data for upload
  let data = {};
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE));
  }
  data[athleteId] = { name, refresh_token: token };

  // Push to GitHub
  await octokit.repos.createOrUpdateFileContents({
    owner: repo.split("/")[0],
    repo: repo.split("/")[1],
    path: pathInRepo,
    message: `Update tokens.json for ${athleteId}`,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
    branch: "main",
    sha
  });

  console.log(`Pushed ${athleteId} to GitHub`);
}

// --- Basic Auth Middleware for /tokens ---
function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).send("Authentication required.");
  }

  const base64Credentials = authHeader.split(' ')[1];
  const [username, password] = Buffer.from(base64Credentials, 'base64').toString('ascii').split(':');

  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    return next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).send("Invalid credentials.");
  }
}

// --- Route: Exchange Strava code ---
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

    if (!tokenData.refresh_token) return res.status(400).json({ message: tokenData.message });

    const { access_token: accessToken, refresh_token: refreshToken } = tokenData;

    // Get athlete profile immediately
    const profileResp = await fetch("https://www.strava.com/api/v3/athlete", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const profile = await profileResp.json();
    const athleteId = profile.id.toString();
    const name = `${profile.firstname || ""} ${profile.lastname || ""}`.trim() || "Unknown Athlete";

    // Save locally
    saveLocalToken(athleteId, name, refreshToken);

    // Respond to frontend immediately
    res.json({ athleteId, name, refresh_token: refreshToken });

    // Push to GitHub asynchronously
    pushTokenToGitHub(athleteId, name, refreshToken).catch(err => {
      console.error("Failed to push token to GitHub:", err);
    });

  } catch (err) {
    console.error("Exchange error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// --- Protected route to view saved tokens ---
app.get("/tokens", basicAuth, (req, res) => {
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE));
    res.json(data);
  } else {
    res.json({});
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
