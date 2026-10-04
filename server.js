import express from "express";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

// ============================================================
// CATALOG
// ============================================================

let catalog = [];

try {
  catalog = JSON.parse(
    fs.readFileSync("./catalog.json", "utf8")
  );

  console.log(`[CATALOG] Loaded ${catalog.length} tracks`);
} catch (err) {
  console.error("[CATALOG ERROR]", err);
}

// ============================================================
// NORMALIZE VIETNAMESE
// ============================================================

function normalize(text = "") {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// SEARCH
// ============================================================

function scoreTrack(track, song, artist) {
  const qSong = normalize(song);
  const qArtist = normalize(artist);

  const title = normalize(track.title);
  const trackArtist = normalize(track.artist);

  let score = 0;

  if (title === qSong) {
    score += 100;
  } else if (
    title.includes(qSong) ||
    qSong.includes(title)
  ) {
    score += 50;
  }

  if (qArtist && trackArtist) {
    if (trackArtist === qArtist) {
      score += 50;
    } else if (
      trackArtist.includes(qArtist) ||
      qArtist.includes(trackArtist)
    ) {
      score += 25;
    }
  }

  return score;
}

function findTrack(song, artist) {
  let best = null;
  let bestScore = 0;

  for (const track of catalog) {
    const score = scoreTrack(track, song, artist);

    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }

  if (!best || bestScore < 50) {
    return null;
  }

  return {
    ...best,
    score: bestScore
  };
}

// ============================================================
// TOKEN CACHE
// ============================================================

const resolvedTracks = new Map();

function createToken(track) {
  const token = crypto.randomBytes(8).toString("hex");

  resolvedTracks.set(token, {
    ...track,
    createdAt: Date.now()
  });

  return token;
}

// ============================================================
// STATUS
// ============================================================

app.get("/", (req, res) => {
  res.json({
    name: "YN Music Server",
    version: "5.0-local",
    status: "online",
    tracks: catalog.length,
    audio: {
      codec: "MP3",
      channels: 1,
      sample_rate: 24000,
      bitrate: "32k"
    }
  });
});

// ============================================================
// DB-ROBOT SEARCH
// ============================================================

app.get("/stream_pcm", (req, res) => {
  const song = String(req.query.song || "").trim();

  const artist = String(
    req.query.artist ||
    req.query.singer ||
    ""
  ).trim();

  console.log("\n====================================");
  console.log("[DB-ROBOT REQUEST]");
  console.log("Song   :", song);
  console.log("Artist :", artist);
  console.log("url    :", req.query.url || "");
  console.log("UA     :", req.headers["user-agent"] || "");
  console.log("====================================");

  if (!song) {
    return res.status(400).json({
      error: "Missing song"
    });
  }

  const track = findTrack(song, artist);

  if (!track) {
    console.log("[SEARCH] NOT FOUND");
    console.log("Song:", song);
    console.log("Artist:", artist);

    return res.status(404).json({
      error: "Song not found",
      title: song,
      artist
    });
  }

  console.log("[SEARCH] MATCH");
  console.log(
    `${song} -> ${track.title} (score ${track.score})`
  );

  const token = createToken(track);

  // DB-Robot requires relative audio URL.
  const audioPath = `/audio/${token}.mp3`;

  const musicItem = {
    title: track.title,
    artist: track.artist || artist,
    audio_url: audioPath,
    audio_full_url: audioPath,
    m3u8_url: "",
    lyric_url: "",
    cover_url: "",
    duration: track.duration || 0,
    from_cache: false,
    ip: ""
  };

  console.log("[DB-ROBOT RESPONSE]");
  console.log(JSON.stringify(musicItem));

  res.json(musicItem);
});

// ============================================================
// AUDIO
// ============================================================

app.get("/audio/:token.mp3", (req, res) => {
  const token = req.params.token;

  const track = resolvedTracks.get(token);

  console.log("\n====================================");
  console.log("[AUDIO REQUEST]");
  console.log("Token :", token);
  console.log("UA    :", req.headers["user-agent"] || "");
  console.log("Range :", req.headers.range || "none");
  console.log("====================================");

  if (!track) {
    console.log("[AUDIO] Unknown token");
    return res.status(404).send("Track not found");
  }

  streamLocalTrack(track, req, res);
});

// ============================================================
// LOCAL MP3 -> FFMPEG -> ROBOT
// ============================================================

function streamLocalTrack(track, req, res) {
  if (!track.source_file) {
    console.error("[AUDIO] source_file missing");
    return res.status(500).send("source_file missing");
  }

  const inputFile = path.resolve(track.source_file);

  console.log("[AUDIO] Track :", track.title);
  console.log("[AUDIO] File  :", inputFile);

  if (!fs.existsSync(inputFile)) {
    console.error("[AUDIO] FILE NOT FOUND:", inputFile);
    return res.status(404).send("Audio file not found");
  }

  res.status(200);

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const args = [
    "-hide_banner",
    "-loglevel", "error",

    "-i", inputFile,

    "-vn",

    // Format proven working with DB-Robot
    "-ac", "1",
    "-ar", "24000",
    "-b:a", "32k",

    "-codec:a", "libmp3lame",

    "-f", "mp3",
    "pipe:1"
  ];

  console.log("[FFMPEG] Starting...");

  const ffmpeg = spawn(
    ffmpegPath,
    args,
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );

  let audioStarted = false;

  ffmpeg.stdout.on("data", () => {
    if (!audioStarted) {
      audioStarted = true;
      console.log("[FFMPEG] Audio stream started");
    }
  });

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on("data", data => {
    console.error(
      "[FFMPEG]",
      data.toString().trim()
    );
  });

  ffmpeg.on("error", err => {
    console.error("[FFMPEG ERROR]", err);

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });

  ffmpeg.on("close", code => {
    console.log("[FFMPEG] exited:", code);

    if (!res.writableEnded) {
      res.end();
    }
  });

  res.on("close", () => {
    if (!ffmpeg.killed) {
      console.log("[FFMPEG] Client disconnected");
      ffmpeg.kill("SIGKILL");
    }
  });
}

// ============================================================
// CLEAN TOKENS
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [token, track] of resolvedTracks) {
    if (now - track.createdAt > 60 * 60 * 1000) {
      resolvedTracks.delete(token);
    }
  }
}, 10 * 60 * 1000);

// ============================================================
// START
// ============================================================
// ============================================================
// V5.1 - AUDIUS ONLINE SEARCH TEST
// ============================================================

app.get("/test-online-search", async (req, res) => {
  const song = String(req.query.song || "").trim();
  const artist = String(req.query.artist || "").trim();

  if (!song) {
    return res.status(400).json({
      error: "Missing song"
    });
  }

  const query = [song, artist]
    .filter(Boolean)
    .join(" ");

  console.log("\n====================================");
  console.log("[ONLINE SEARCH TEST]");
  console.log("Query:", query);
  console.log("====================================");

  try {
    const api =
      "https://api.audius.co/v1/tracks/search" +
      "?query=" +
      encodeURIComponent(query) +
      "&limit=10";

    const response = await fetch(api, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "YN-Music-Server/5.1"
      }
    });

    console.log(
      "[AUDIUS] HTTP:",
      response.status
    );

    if (!response.ok) {
      const body = await response.text();

      console.log(
        "[AUDIUS ERROR]",
        body
      );

      return res.status(502).json({
        error: "Audius search failed",
        status: response.status
      });
    }

    const json = await response.json();

    const tracks = (json.data || []).map(track => ({
      id: track.id,
      title: track.title,
      artist:
        track.user?.name ||
        track.user?.handle ||
        "",
      duration: track.duration || 0,
      genre: track.genre || ""
    }));

    console.log(
      `[AUDIUS] Found ${tracks.length} tracks`
    );

    for (const track of tracks) {
      console.log(
        `[AUDIUS] ${track.title} - ${track.artist} (${track.id})`
      );
    }

    return res.json({
      query,
      count: tracks.length,
      tracks
    });

  } catch (err) {
    console.error(
      "[AUDIUS ERROR]",
      err
    );

    return res.status(500).json({
      error: String(err)
    });
  }
});
// ============================================================
// V5.1 - AUDIUS STREAM TEST
// ============================================================

app.get("/test-audius-play/:trackId", (req, res) => {
  const trackId = req.params.trackId;

  const sourceUrl =
    `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream`;

  console.log("\n====================================");
  console.log("[AUDIUS PLAY TEST]");
  console.log("Track ID :", trackId);
  console.log("Source   :", sourceUrl);
  console.log("UA       :", req.headers["user-agent"] || "");
  console.log("Range    :", req.headers.range || "none");
  console.log("====================================");

  res.status(200);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const args = [
    "-hide_banner",
    "-loglevel", "error",

    "-i", sourceUrl,

    "-vn",

    // DB-ROBOT format đã test thành công
    "-ac", "1",
    "-ar", "24000",
    "-b:a", "32k",
    "-codec:a", "libmp3lame",

    "-f", "mp3",
    "pipe:1"
  ];

  console.log("[FFMPEG AUDIUS] Starting...");

  const ffmpeg = spawn(
    ffmpegPath,
    args,
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );

  let started = false;

  ffmpeg.stdout.on("data", () => {
    if (!started) {
      started = true;
      console.log(
        "[FFMPEG AUDIUS] Audio stream started"
      );
    }
  });

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on("data", data => {
    console.error(
      "[FFMPEG AUDIUS]",
      data.toString().trim()
    );
  });

  ffmpeg.on("error", err => {
    console.error(
      "[FFMPEG AUDIUS ERROR]",
      err
    );

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });

  ffmpeg.on("close", code => {
    console.log(
      "[FFMPEG AUDIUS] exited:",
      code
    );

    if (!res.writableEnded) {
      res.end();
    }
  });

  res.on("close", () => {
    if (!ffmpeg.killed) {
      console.log(
        "[FFMPEG AUDIUS] Client disconnected"
      );

      ffmpeg.kill("SIGKILL");
    }
  });
});
console.log("[ROUTE] /test-audius-play/:trackId registered");
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `YN Music Server V5 LOCAL running on port ${PORT}`
  );

  console.log(
    `[CATALOG] ${catalog.length} tracks ready`
  );
});
