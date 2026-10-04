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
  return String(text)
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
// LEVENSHTEIN / SIMILARITY
// ============================================================

function levenshtein(a, b) {
  const matrix = Array.from(
    { length: b.length + 1 },
    () => Array(a.length + 1).fill(0)
  );

  for (let i = 0; i <= b.length; i++) {
    matrix[i][0] = i;
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  const distance = levenshtein(a, b);
  const maxLength = Math.max(a.length, b.length);

  return 1 - distance / maxLength;
}

// ============================================================
// LOCAL SEARCH
// ============================================================

function scoreLocalTrack(track, song, artist) {
  const titleScore = similarity(
    song,
    track.title
  );

  let artistScore = 0;

  if (artist && track.artist) {
    artistScore = similarity(
      artist,
      track.artist
    );
  }

  return (
    titleScore * 100 +
    artistScore * 30
  );
}

function findLocalTrack(song, artist) {
  let best = null;
  let bestScore = 0;

  for (const track of catalog) {
    const score = scoreLocalTrack(
      track,
      song,
      artist
    );

    console.log(
      `[LOCAL] Candidate: ${track.title} | score=${score.toFixed(1)}`
    );

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  if (!best || bestScore < 70) {
    return null;
  }

  return {
    ...best,
    provider: "local",
    score: Math.round(bestScore)
  };
}

// ============================================================
// AUDIUS SEARCH
// ============================================================

async function searchAudius(song, artist = "") {
  const query = [song, artist]
    .filter(Boolean)
    .join(" ");

  const url =
    "https://api.audius.co/v1/tracks/search" +
    "?query=" +
    encodeURIComponent(query) +
    "&limit=10";

  console.log(
    "[AUDIUS SEARCH] Query:",
    query
  );

  const response = await fetch(url, {
    redirect: "follow",

    headers: {
      Accept: "application/json",
      "User-Agent": "YN-Music-Server/5.2"
    }
  });

  console.log(
    "[AUDIUS SEARCH] HTTP:",
    response.status
  );

  if (!response.ok) {
    throw new Error(
      `Audius search HTTP ${response.status}`
    );
  }

  const json = await response.json();

  return (json.data || []).map(track => ({
    id: track.id,

    title:
      track.title || "",

    artist:
      track.user?.name ||
      track.user?.handle ||
      "",

    duration:
      track.duration || 0,

    genre:
      track.genre || "",

    provider: "audius"
  }));
}

// ============================================================
// SCORE AUDIUS RESULTS
// ============================================================

function scoreAudiusTrack(track, song, artist) {
  const requestedSong =
    normalize(song);

  const requestedArtist =
    normalize(artist);

  const trackTitle =
    normalize(track.title);

  const uploader =
    normalize(track.artist);

  let score = 0;

  // Exact-ish title similarity
  score += similarity(
    requestedSong,
    trackTitle
  ) * 100;

  // Many Audius uploads contain artist in title:
  // "Lac Troi - Son Tung M-TP"
  if (
    requestedSong &&
    trackTitle.includes(requestedSong)
  ) {
    score += 50;
  }

  if (requestedArtist) {
    if (
      trackTitle.includes(requestedArtist)
    ) {
      score += 50;
    }

    if (
      uploader.includes(requestedArtist)
    ) {
      score += 30;
    }

    score += similarity(
      requestedArtist,
      uploader
    ) * 20;
  }

  return score;
}

function chooseAudiusTrack(
  tracks,
  song,
  artist
) {
  let best = null;
  let bestScore = 0;

  for (const track of tracks) {
    const score = scoreAudiusTrack(
      track,
      song,
      artist
    );

    console.log(
      `[AUDIUS CANDIDATE] ` +
      `${track.title} - ${track.artist} ` +
      `| score=${score.toFixed(1)}`
    );

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  if (!best) {
    return null;
  }

  return {
    ...best,
    score: Math.round(bestScore)
  };
}

// ============================================================
// TOKEN CACHE
// ============================================================

const resolvedTracks = new Map();

function createToken(track) {
  const token =
    crypto.randomBytes(8).toString("hex");

  resolvedTracks.set(token, {
    ...track,
    createdAt: Date.now()
  });

  return token;
}

// ============================================================
// MUSIC ITEM
// ============================================================

function makeMusicItem(track, token) {
  const audioPath =
    `/audio/${token}.mp3`;

  return {
    title: track.title || "",

    artist: track.artist || "",

    audio_url: audioPath,

    audio_full_url: audioPath,

    m3u8_url: "",

    lyric_url: "",

    cover_url: "",

    duration:
      track.duration || 0,

    from_cache:
      track.provider === "local",

    ip: ""
  };
}

// ============================================================
// STATUS
// ============================================================

app.get("/", (req, res) => {
  res.json({
    name: "YN Music Server",
    version: "5.2",
    status: "online",

    local_tracks:
      catalog.length,

    search_order: [
      "local",
      "audius"
    ],

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
//
// LOCAL -> AUDIUS
// ============================================================

app.get(
  "/stream_pcm",
  async (req, res) => {
    const song = String(
      req.query.song || ""
    ).trim();

    const artist = String(
      req.query.artist ||
      req.query.singer ||
      ""
    ).trim();

    console.log(
      "\n===================================="
    );

    console.log(
      "[DB-ROBOT REQUEST]"
    );

    console.log(
      "Song   :",
      song
    );

    console.log(
      "Artist :",
      artist
    );

    console.log(
      "url    :",
      req.query.url || ""
    );

    console.log(
      "UA     :",
      req.headers["user-agent"] || ""
    );

    console.log(
      "===================================="
    );

    if (!song) {
      return res
        .status(400)
        .json({
          error: "Missing song"
        });
    }

    // ========================================================
    // 1. LOCAL
    // ========================================================

    const localTrack =
      findLocalTrack(
        song,
        artist
      );

    if (localTrack) {
      console.log(
        "[LOCAL] MATCH"
      );

      console.log(
        `${song} -> ${localTrack.title}`
      );

      const token =
        createToken(localTrack);

      const musicItem =
        makeMusicItem(
          localTrack,
          token
        );

      console.log(
        "[DB-ROBOT RESPONSE]"
      );

      console.log(
        JSON.stringify(musicItem)
      );

      return res.json(
        musicItem
      );
    }

    console.log(
      "[LOCAL] NOT FOUND"
    );

    // ========================================================
    // 2. AUDIUS
    // ========================================================

    try {
      const results =
        await searchAudius(
          song,
          artist
        );

      console.log(
        `[AUDIUS] Found ${results.length} tracks`
      );

      const onlineTrack =
        chooseAudiusTrack(
          results,
          song,
          artist
        );

      if (!onlineTrack) {
        console.log(
          "[AUDIUS] NO MATCH"
        );

        return res
          .status(404)
          .json({
            error:
              "Song not found",

            title:
              song,

            artist
          });
      }

      console.log(
        "[AUDIUS] MATCH"
      );

      console.log(
        "ID     :",
        onlineTrack.id
      );

      console.log(
        "Title  :",
        onlineTrack.title
      );

      console.log(
        "Artist :",
        onlineTrack.artist
      );

      console.log(
        "Score  :",
        onlineTrack.score
      );

      const token =
        createToken(
          onlineTrack
        );

      const musicItem =
        makeMusicItem(
          onlineTrack,
          token
        );

      console.log(
        "[DB-ROBOT RESPONSE]"
      );

      console.log(
        JSON.stringify(
          musicItem
        )
      );

      return res.json(
        musicItem
      );

    } catch (err) {
      console.error(
        "[AUDIUS SEARCH ERROR]",
        err
      );

      return res
        .status(502)
        .json({
          error:
            "Online music search failed",

          detail:
            String(err)
        });
    }
  }
);

// ============================================================
// AUDIO TOKEN
// ============================================================

app.get(
  "/audio/:token.mp3",
  (req, res) => {
    const token =
      req.params.token;

    const track =
      resolvedTracks.get(
        token
      );

    console.log(
      "\n===================================="
    );

    console.log(
      "[AUDIO REQUEST]"
    );

    console.log(
      "Token    :",
      token
    );

    console.log(
      "UA       :",
      req.headers["user-agent"] || ""
    );

    console.log(
      "Range    :",
      req.headers.range || "none"
    );

    console.log(
      "===================================="
    );

    if (!track) {
      return res
        .status(404)
        .send(
          "Track not found"
        );
    }

    console.log(
      "[AUDIO] Provider:",
      track.provider
    );

    if (
      track.provider ===
      "audius"
    ) {
      return streamAudiusTrack(
        track,
        req,
        res
      );
    }

    return streamLocalTrack(
      track,
      req,
      res
    );
  }
);

// ============================================================
// LOCAL AUDIO
// ============================================================

function streamLocalTrack(
  track,
  req,
  res
) {
  if (!track.source_file) {
    return res
      .status(500)
      .send(
        "source_file missing"
      );
  }

  const inputFile =
    path.resolve(
      track.source_file
    );

  console.log(
    "[LOCAL AUDIO] Track:",
    track.title
  );

  console.log(
    "[LOCAL AUDIO] File :",
    inputFile
  );

  if (
    !fs.existsSync(
      inputFile
    )
  ) {
    console.error(
      "[LOCAL AUDIO] FILE NOT FOUND"
    );

    return res
      .status(404)
      .send(
        "Audio file not found"
      );
  }

  res.status(200);

  res.setHeader(
    "Content-Type",
    "audio/mpeg"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache"
  );

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",

    "-i",
    inputFile,

    "-vn",

    "-ac",
    "1",

    "-ar",
    "24000",

    "-b:a",
    "32k",

    "-codec:a",
    "libmp3lame",

    "-f",
    "mp3",

    "pipe:1"
  ];

  console.log(
    "[FFMPEG LOCAL] Starting..."
  );

  const ffmpeg =
    spawn(
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

  ffmpeg.stdout.on(
    "data",
    () => {
      if (!started) {
        started = true;

        console.log(
          "[FFMPEG LOCAL] Audio stream started"
        );
      }
    }
  );

  ffmpeg.stdout.pipe(
    res
  );

  ffmpeg.stderr.on(
    "data",
    data => {
      console.error(
        "[FFMPEG LOCAL STDERR]",
        data
          .toString()
          .trim()
      );
    }
  );

  ffmpeg.on(
    "close",
    (code, signal) => {
      console.log(
        "[FFMPEG LOCAL] CLOSE",
        "code =", code,
        "signal =", signal
      );

      if (
        !res.writableEnded
      ) {
        res.end();
      }
    }
  );
}

// ============================================================
// AUDIUS AUDIO
//
// Audius -> Node fetch -> FFmpeg stdin -> ESP32
// ============================================================

async function streamAudiusTrack(
  track,
  req,
  res
) {
  const sourceUrl =
    `https://api.audius.co/v1/tracks/${encodeURIComponent(track.id)}/stream`;

  console.log(
    "[AUDIUS AUDIO] ID    :",
    track.id
  );

  console.log(
    "[AUDIUS AUDIO] Title :",
    track.title
  );

  console.log(
    "[AUDIUS AUDIO] Source:",
    sourceUrl
  );

  try {
    // ========================================================
    // NODE DOWNLOADS AUDIUS
    // ========================================================

    const upstream =
      await fetch(
        sourceUrl,
        {
          redirect:
            "follow",

          headers: {
            Accept:
              "*/*",

            "User-Agent":
              "YN-Music-Server/5.2"
          }
        }
      );

    console.log(
      "[AUDIUS FETCH] HTTP:",
      upstream.status
    );

    console.log(
      "[AUDIUS FETCH] Type:",
      upstream.headers.get(
        "content-type"
      )
    );

    console.log(
      "[AUDIUS FETCH] Length:",
      upstream.headers.get(
        "content-length"
      )
    );

    if (
      !upstream.ok ||
      !upstream.body
    ) {
      console.error(
        "[AUDIUS FETCH] FAILED"
      );

      return res
        .status(502)
        .send(
          "Audius stream failed"
        );
    }

    // ========================================================
    // RESPONSE TO ESP32
    // ========================================================

    res.status(200);

    res.setHeader(
      "Content-Type",
      "audio/mpeg"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache"
    );

    // ========================================================
    // FFMPEG STDIN
    // ========================================================

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",

      "-i",
      "pipe:0",

      "-vn",

      "-ac",
      "1",

      "-ar",
      "24000",

      "-b:a",
      "32k",

      "-codec:a",
      "libmp3lame",

      "-f",
      "mp3",

      "pipe:1"
    ];

    console.log(
      "[FFMPEG AUDIUS] Starting via stdin..."
    );

    const ffmpeg =
      spawn(
        ffmpegPath,
        args,
        {
          stdio: [
            "pipe",
            "pipe",
            "pipe"
          ]
        }
      );

    console.log(
      "[FFMPEG AUDIUS] PID:",
      ffmpeg.pid
    );

    let started = false;

    ffmpeg.stdout.on(
      "data",
      () => {
        if (!started) {
          started = true;

          console.log(
            "[FFMPEG AUDIUS] Audio stream started"
          );
        }
      }
    );

    ffmpeg.stdout.pipe(
      res
    );

    ffmpeg.stderr.on(
      "data",
      data => {
        console.error(
          "[FFMPEG AUDIUS STDERR]",
          data
            .toString()
            .trim()
        );
      }
    );

    ffmpeg.on(
      "error",
      err => {
        console.error(
          "[FFMPEG AUDIUS ERROR]",
          err
        );
      }
    );

    ffmpeg.on(
      "exit",
      (code, signal) => {
        console.log(
          "[FFMPEG AUDIUS] EXIT",
          "code =", code,
          "signal =", signal
        );
      }
    );

    ffmpeg.on(
      "close",
      (code, signal) => {
        console.log(
          "[FFMPEG AUDIUS] CLOSE",
          "code =", code,
          "signal =", signal
        );

        if (
          !res.writableEnded
        ) {
          res.end();
        }
      }
    );

    // ========================================================
    // AUDIUS BODY -> FFMPEG STDIN
    // ========================================================

    const reader =
      upstream.body.getReader();

    try {
      while (true) {
        const {
          done,
          value
        } =
          await reader.read();

        if (done) {
          console.log(
            "[AUDIUS FETCH] Stream finished"
          );

          ffmpeg.stdin.end();

          break;
        }

        const buffer =
          Buffer.from(
            value
          );

        if (
          !ffmpeg.stdin.write(
            buffer
          )
        ) {
          await new Promise(
            resolve => {
              ffmpeg.stdin.once(
                "drain",
                resolve
              );
            }
          );
        }
      }

    } catch (err) {
      console.error(
        "[AUDIUS PIPE ERROR]",
        err
      );

      if (
        !ffmpeg.stdin.destroyed
      ) {
        ffmpeg.stdin.destroy();
      }
    }

  } catch (err) {
    console.error(
      "[AUDIUS AUDIO ERROR]",
      err
    );

    if (
      !res.headersSent
    ) {
      res
        .status(502)
        .send(
          "Audius audio error"
        );
    } else {
      res.end();
    }
  }
}

// ============================================================
// CLEAN OLD TOKENS
// ============================================================

setInterval(() => {
  const now =
    Date.now();

  for (
    const [token, track]
    of resolvedTracks
  ) {
    if (
      now -
      track.createdAt >
      60 * 60 * 1000
    ) {
      resolvedTracks.delete(
        token
      );
    }
  }
}, 10 * 60 * 1000);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `YN Music Server V5.2 running on port ${PORT}`
    );

    console.log(
      `[CATALOG] ${catalog.length} local tracks ready`
    );

    console.log(
      "[SEARCH] Local -> Audius enabled"
    );
  }
);
