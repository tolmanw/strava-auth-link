// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { Octokit } = require("@octokit/rest");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS: allow frontend domain ---
app.use(cors({
  origin: process.env.FRONTEND_URL // https://tolmanw.github.io
}));

// Path to local JSON
const DATA_FILE = path.join(__dirname, process.env.DATA_FILE || "tokens.json");

// GitHub Octokit client
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

// --- Save token locally ---
function saveLocalToken(athleteId, name, token) {
  let data = {};
  if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE));
  data[athleteId] = { name, refresh_token: token };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`Saved locally: ${athleteId} (${name})`);
}

// --- Push token to GitHub asynchronously ---
async function pushTokenToGitHub(athleteId, name, token) {
  const repo = process.env.DATA_REPO; // e.g., "username/private-repo"
  const pathInRepo = process.env.DATA_FILE || "tokens.json";
  let sha;

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

  let data = {};
  if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE));
  data[athleteId] = { name, refresh_token: token };

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

// --- Exchange Strava code ---
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
        grant_type: "authorization_code",
        redirect_uri: process.env.REDIRECT_URI // must match frontend
      })
    });

    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) return res.status(400).json(tokenData);

    const { access_token, refresh_token } = tokenData;

    const profileResp = await fetch("https://www.strava.com/api/v3/athlete", {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const profile = await profileResp.json();

    const athleteId = profile.id.toString();
    const name = `${profile.firstname || ""} ${profile.lastname || ""}`.trim() || "Unknown Athlete";

    saveLocalToken(athleteId, name, refresh_token);

    // Respond immediately
    res.json({ athleteId, name, refresh_token });

    // Push to GitHub asynchronously
    pushTokenToGitHub(athleteId, name, refresh_token)
      .catch(err => console.error("GitHub push failed:", err));

  } catch (err) {
    console.error("Exchange error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Optional protected route to view saved tokens
app.get("/tokens", (req, res) => {
  if (fs.existsSync(DATA_FILE)) res.json(JSON.parse(fs.readFileSync(DATA_FILE)));
  else res.json({});
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
