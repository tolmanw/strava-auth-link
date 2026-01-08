// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));

// --------------------
// GitHub helpers
// --------------------
const TMP_DIR = path.join(__dirname, "data");
const TOKENS_FILE = path.join(TMP_DIR, process.env.DATA_FILE);

async function githubRequest(url, method = "GET", body) {
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json"
  };

  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub error: ${res.status} ${text}`);
  }

  return res.json();
}

async function pullTokensFromGitHub() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

  try {
    const file = await githubRequest(
      `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${process.env.DATA_REPO}/contents/${process.env.DATA_FILE}`
    );

    const content = Buffer.from(file.content, "base64").toString("utf-8");
    fs.writeFileSync(TOKENS_FILE, content);
    return file.sha;
  } catch {
    fs.writeFileSync(TOKENS_FILE, "{}");
    return null;
  }
}

async function pushTokensToGitHub(json, sha) {
  const content = Buffer.from(JSON.stringify(json, null, 2)).toString("base64");

  await githubRequest(
    `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${process.env.DATA_REPO}/contents/${process.env.DATA_FILE}`,
    "PUT",
    {
      message: "Update Strava refresh tokens",
      content,
      sha
    }
  );
}

// --------------------
// Save token (atomic)
// --------------------
async function saveRefreshToken(athleteId, name, refreshToken) {
  const sha = await pullTokensFromGitHub();
  const data = JSON.parse(fs.readFileSync(TOKENS_FILE));

  data[athleteId] = {
    name,
    refresh_token: refreshToken,
    updated_at: new Date().toISOString()
  };

  await pushTokensToGitHub(data, sha);
}

// --------------------
// Basic Auth
// --------------------
function basicAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Restricted"');
    return res.status(401).send("Auth required");
  }

  const [user, pass] = Buffer.from(auth.split(" ")[1], "base64")
    .toString()
    .split(":");

  if (
    user === process.env.ADMIN_USER &&
    pass === process.env.ADMIN_PASS
  ) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Restricted"');
  res.status(401).send("Invalid credentials");
}

// --------------------
// Routes
// --------------------
app.get("/exchange-code", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ message: "Missing code" });

  try {
    // Exchange auth code
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
    if (!tokenData.refresh_token)
      return res.status(400).json(tokenData);

    // Fetch athlete
    const profileResp = await fetch(
      "https://www.strava.com/api/v3/athlete",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    const athlete = await profileResp.json();

    await saveRefreshToken(
      athlete.id.toString(),
      `${athlete.firstname} ${athlete.lastname}`,
      tokenData.refresh_token
    );

    res.json({
      success: true,
      athleteId: athlete.id,
      name: `${athlete.firstname} ${athlete.lastname}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Protected viewer
app.get("/tokens", basicAuth, async (req, res) => {
  await pullTokensFromGitHub();
  res.json(JSON.parse(fs.readFileSync(TOKENS_FILE)));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
