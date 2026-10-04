import express from "express";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
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
  console.error("[CATALOG] Load error:", err);
}


// ============================================================
// HELPERS
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


function scoreTrack(track, song, artist) {
  const tTitle = normalize(track.title);
  const tArtist = normalize(track.artist);

  const qTitle = normalize(song);
  const qArtist = normalize(artist);

  let score = 0;

  // Title
  if (tTitle === qTitle) {
    score += 100;
  } else if (
    tTitle.includes(qTitle) ||
    qTitle.includes(tTitle)
  ) {
    score += 50;
  }

  // Artist
  if (qArtist) {
    if (tArtist === qArtist) {
      score += 50;
    } else if (
      tArtist.includes(qArtist) ||
      qArtist.includes(tArtist)
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
      bestScore = score;
      best = track;
    }
  }

  // Tránh match quá lỏng
  if (bestScore < 50) {
    return null;
  }

  return {
    ...best,
    score: bestScore
  };
}


// ============================================================
// TEMP TRACK CACHE
// ============================================================

const resolvedTracks = new Map();

function createTrackToken(track) {
  const token = crypto.randomBytes(8).toString("hex");

  resolvedTracks.set(token, {
    ...track,
    createdAt: Date.now()
  });

  return token;
}


// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {
  res.json({
    name: "YN Music Server",
    version: "5.0.0",
    status: "online",
    tracks: catalog.length,
    audio: {
      codec: "MP3",
      sample_rate: 24000,
      channels: 1,
      bitrate: "32k"
    }
  });
});


// ============================================================
// DB-ROBOT MUSIC SEARCH
// ============================================================

app.get("/stream_pcm", async (req, res) => {
  const song = (req.query.song || "").trim();

  const artist = (
    req.query.artist ||
    req.query.singer ||
    ""
  ).trim();

  const directPlay = req.query.url === "true";

  const ua = req.headers["user-agent"] || "";

  console.log("\n====================================");
  console.log("[DB-ROBOT REQUEST]");
  console.log("Song   :", song);
  console.log("Artist :", artist);
  console.log("url    :", req.query.url || "");
  console.log("UA     :", ua);
  console.log("====================================");


  if (!song) {
    return res.status(400).json({
      error: "Missing song"
    });
  }


  // ----------------------------------------------------------
  // SEARCH
  // ----------------------------------------------------------

  const track = findTrack(song, artist);

  if (!track) {
    console.log("[SEARCH] NOT FOUND:", song, artist);

    return res.status(404).json({
      error: "Song not found",
      title: song,
      artist
    });
  }


  console.log("[SEARCH] MATCH");
  console.log("Requested:", song, "-", artist);
  console.log("Found    :", track.title, "-", track.artist);
  console.log("Score    :", track.score);


  // ----------------------------------------------------------
  // CREATE TEMP AUDIO TOKEN
  // ----------------------------------------------------------

  const token = createTrackToken(track);

  const audioPath = `/audio/${token}.mp3`;


  // ----------------------------------------------------------
  // ORIGINAL MEOW STYLE RESPONSE
  // ----------------------------------------------------------

  const musicItem = {
    title: track.title,
    artist: track.artist,

    // IMPORTANT:
    // relative URL is required by DB-ROBOT
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


  // Normal DB-Robot request
  if (!directPlay) {
    return res.json(musicItem);
  }


  // Optional compatibility with ?url=true
  return streamTrack(track, req, res);
});


// ============================================================
// AUDIO ENDPOINT
// ============================================================

app.get("/audio/:token.mp3", async (req, res) => {
  const token = req.params.token;

  const track = resolvedTracks.get(token);

  console.log("\n====================================");
  console.log("[AUDIO REQUEST]");
  console.log("Token :", token);
  console.log("UA    :", req.headers["user-agent"] || "");
  console.log("Range :", req.headers.range || "none");
  console.log("====================================");


  if (!track) {
    console.log("[AUDIO] Invalid/expired token");

    return res.status(404).send("Track not found");
  }


  console.log(
    "[AUDIO] Playing:",
    track.title,
    "-",
    track.artist
  );

  return streamTrack(track, req, res);
});


// ============================================================
// FFMPEG → DB-ROBOT FORMAT
// ============================================================

function streamTrack(track, req, res) {
  if (!track.source_url) {
    return res.status(500).send(
      "Track has no source_url"
    );
  }


  console.log("[FFMPEG] Source:", track.source_url);


  // DB-Robot requested Range bytes=0- during our successful test,
  // but transcoded output is a fresh stream, so return 200.
  res.status(200);

  res.setHeader(
    "Content-Type",
    "audio/mpeg"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );


  const args = [
    "-hide_banner",
    "-loglevel", "error",

    "-i", track.source_url,

    "-vn",

    // Same format used by Meow
    "-ac", "1",
    "-ar", "24000",
    "-b:a", "32k",

    "-codec:a", "libmp3lame",

    "-f", "mp3",
    "pipe:1"
  ];


  console.log(
    "[FFMPEG]",
    ffmpegPath,
    args.join(" ")
  );


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
        "[FFMPEG] Audio stream started"
      );
    }
  });


  ffmpeg.stdout.pipe(res);


  ffmpeg.stderr.on("data", data => {
    console.error(
      "[FFMPEG]",
      data.toString().trim()
    );
  });


  ffmpeg.on("close", code => {
    console.log(
      "[FFMPEG] exited:",
      code
    );

    if (!res.writableEnded) {
      res.end();
    }
  });


  ffmpeg.on("error", err => {
    console.error(
      "[FFMPEG ERROR]",
      err
    );

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });


  // IMPORTANT:
  // Kill FFmpeg only when response/client actually closes.
  res.on("close", () => {
    if (!ffmpeg.killed) {
      console.log(
        "[FFMPEG] Client disconnected"
      );

      ffmpeg.kill("SIGKILL");
    }
  });
}


// ============================================================
// CLEAN OLD TOKENS
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [token, track] of resolvedTracks) {
    if (
      now - track.createdAt >
      60 * 60 * 1000
    ) {
      resolvedTracks.delete(token);
    }
  }
}, 10 * 60 * 1000);


// ============================================================
// START
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `YN Music Server V5 running on port ${PORT}`
  );

  console.log(
    `[CATALOG] ${catalog.length} tracks ready`
  );
});
