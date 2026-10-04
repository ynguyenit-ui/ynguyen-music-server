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
// FUZZY SEARCH
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

function scoreTrack(track, song, artist) {
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

function findTrack(song, artist) {
  let best = null;
  let bestScore = 0;

  for (const track of catalog) {
    const score = scoreTrack(
      track,
      song,
      artist
    );

    console.log(
      `[SEARCH] Candidate: ${track.title} | score=${score.toFixed(1)}`
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
    score: Math.round(bestScore)
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
// HOME / STATUS
// ============================================================

app.get("/", (req, res) => {
  res.json({
    name: "YN Music Server",
    version: "5.1",
    status: "online",

    local_tracks: catalog.length,

    audio: {
      codec: "MP3",
      channels: 1,
      sample_rate: 24000,
      bitrate: "32k"
    },

    features: {
      local_catalog: true,
      fuzzy_search: true,
      audius_search_test: true,
      audius_stream_test: true
    }
  });
});

// ============================================================
// DB-ROBOT /stream_pcm
//
// Hiện tại route chính vẫn dùng LOCAL.
// Sau khi Audius stream test thành công,
// ta sẽ thêm fallback online vào đây.
// ============================================================

app.get("/stream_pcm", (req, res) => {
  const song = String(
    req.query.song || ""
  ).trim();

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

  // ----------------------------------------------------------
  // LOCAL SEARCH
  // ----------------------------------------------------------

  const track = findTrack(
    song,
    artist
  );

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

  const token = createToken({
    ...track,
    provider: "local"
  });

  const audioPath =
    `/audio/${token}.mp3`;

  const musicItem = {
    title: track.title,
    artist: track.artist || artist,

    // DB-Robot cần relative URL
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
  console.log(
    JSON.stringify(musicItem)
  );

  return res.json(musicItem);
});

// ============================================================
// DB-ROBOT AUDIO
// ============================================================

app.get("/audio/:token.mp3", (req, res) => {
  const token = req.params.token;

  const track =
    resolvedTracks.get(token);

  console.log("\n====================================");
  console.log("[AUDIO REQUEST]");
  console.log("Token :", token);
  console.log("UA    :", req.headers["user-agent"] || "");
  console.log("Range :", req.headers.range || "none");
  console.log("====================================");

  if (!track) {
    console.log("[AUDIO] Unknown token");

    return res
      .status(404)
      .send("Track not found");
  }

  console.log(
    "[AUDIO] Provider:",
    track.provider || "local"
  );

  // V5.1 hiện route chính vẫn LOCAL
  return streamLocalTrack(
    track,
    req,
    res
  );
});

// ============================================================
// LOCAL FILE -> FFMPEG -> DB-ROBOT
// ============================================================

function streamLocalTrack(track, req, res) {
  if (!track.source_file) {
    console.error(
      "[AUDIO] source_file missing"
    );

    return res
      .status(500)
      .send("source_file missing");
  }

  const inputFile =
    path.resolve(track.source_file);

  console.log(
    "[AUDIO] Track :",
    track.title
  );

  console.log(
    "[AUDIO] File  :",
    inputFile
  );

  if (!fs.existsSync(inputFile)) {
    console.error(
      "[AUDIO] FILE NOT FOUND:",
      inputFile
    );

    return res
      .status(404)
      .send("Audio file not found");
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

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  const args = [
    "-hide_banner",
    "-loglevel", "error",

    "-i", inputFile,

    "-vn",

    // DB-ROBOT compatible audio
    "-ac", "1",
    "-ar", "24000",
    "-b:a", "32k",

    "-codec:a", "libmp3lame",

    "-f", "mp3",
    "pipe:1"
  ];

  console.log(
    "[FFMPEG LOCAL] Starting..."
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

  console.log(
    "[FFMPEG LOCAL] PID:",
    ffmpeg.pid
  );

  let started = false;

  ffmpeg.stdout.on("data", () => {
    if (!started) {
      started = true;

      console.log(
        "[FFMPEG LOCAL] Audio stream started"
      );
    }
  });

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on(
    "data",
    data => {
      console.error(
        "[FFMPEG LOCAL STDERR]",
        data.toString().trim()
      );
    }
  );

  ffmpeg.on("error", err => {
    console.error(
      "[FFMPEG LOCAL ERROR]",
      err
    );
  });

  ffmpeg.on(
    "exit",
    (code, signal) => {
      console.log(
        "[FFMPEG LOCAL] EXIT",
        "code =", code,
        "signal =", signal
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

      if (!res.writableEnded) {
        res.end();
      }
    }
  );
}

// ============================================================
// AUDIUS SEARCH
// ============================================================

async function searchAudius(
  song,
  artist = ""
) {
  const query = [
    song,
    artist
  ]
    .filter(Boolean)
    .join(" ");

  const api =
    "https://api.audius.co/v1/tracks/search" +
    "?query=" +
    encodeURIComponent(query) +
    "&limit=10";

  console.log(
    "[AUDIUS SEARCH] Query:",
    query
  );

  const response = await fetch(
    api,
    {
      redirect: "follow",

      headers: {
        "Accept": "application/json",
        "User-Agent":
          "YN-Music-Server/5.1"
      }
    }
  );

  console.log(
    "[AUDIUS SEARCH] HTTP:",
    response.status
  );

  if (!response.ok) {
    const body =
      await response.text();

    console.error(
      "[AUDIUS SEARCH ERROR]",
      body.slice(0, 500)
    );

    throw new Error(
      `Audius search HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  return (json.data || []).map(
    track => ({
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
        track.genre || ""
    })
  );
}

// ============================================================
// TEST AUDIUS SEARCH
//
// /test-online-search?song=Lac%20Troi&artist=Son%20Tung
// ============================================================

app.get(
  "/test-online-search",
  async (req, res) => {
    const song = String(
      req.query.song || ""
    ).trim();

    const artist = String(
      req.query.artist || ""
    ).trim();

    if (!song) {
      return res
        .status(400)
        .json({
          error: "Missing song"
        });
    }

    console.log(
      "\n===================================="
    );

    console.log(
      "[ONLINE SEARCH TEST]"
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
      "===================================="
    );

    try {
      const tracks =
        await searchAudius(
          song,
          artist
        );

      console.log(
        `[AUDIUS] Found ${tracks.length} tracks`
      );

      for (const track of tracks) {
        console.log(
          `[AUDIUS] ${track.title} - ${track.artist} (${track.id})`
        );
      }

      return res.json({
        query: [
          song,
          artist
        ]
          .filter(Boolean)
          .join(" "),

        count:
          tracks.length,

        tracks
      });

    } catch (err) {
      console.error(
        "[AUDIUS ERROR]",
        err
      );

      return res
        .status(500)
        .json({
          error:
            String(err)
        });
    }
  }
);

// ============================================================
// TEST AUDIUS PLAY
//
// IMPORTANT:
// Node fetches HTTPS.
// FFmpeg receives audio through stdin.
//
// This avoids ffmpeg-static SIGSEGV when FFmpeg
// opens the Audius HTTPS URL itself.
// ============================================================

app.get(
  "/test-audius-play/:trackId",
  async (req, res) => {
    const trackId =
      req.params.trackId;

    const sourceUrl =
      `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream`;

    console.log(
      "\n===================================="
    );

    console.log(
      "[AUDIUS PLAY TEST]"
    );

    console.log(
      "Track ID :",
      trackId
    );

    console.log(
      "Source   :",
      sourceUrl
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

    try {
      // ------------------------------------------------------
      // NODE FETCHES AUDIUS
      // ------------------------------------------------------

      const upstream =
        await fetch(
          sourceUrl,
          {
            redirect: "follow",

            headers: {
              "Accept": "*/*",

              "User-Agent":
                "YN-Music-Server/5.1"
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

      if (!upstream.ok) {
        const body =
          await upstream.text();

        console.error(
          "[AUDIUS FETCH ERROR]",
          body.slice(0, 500)
        );

        return res
          .status(502)
          .send(
            `Audius HTTP ${upstream.status}`
          );
      }

      if (!upstream.body) {
        return res
          .status(502)
          .send(
            "Audius returned no body"
          );
      }

      // ------------------------------------------------------
      // RESPONSE TO BROWSER / ROBOT
      // ------------------------------------------------------

      res.status(200);

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "Cache-Control",
        "no-cache"
      );

      // ------------------------------------------------------
      // FFMPEG READS STDIN
      // ------------------------------------------------------

      const args = [
        "-hide_banner",
        "-loglevel", "error",

        "-i", "pipe:0",

        "-vn",

        "-ac", "1",
        "-ar", "24000",
        "-b:a", "32k",

        "-codec:a",
        "libmp3lame",

        "-f", "mp3",
        "pipe:1"
      ];

      console.log(
        "[FFMPEG AUDIUS] Starting via stdin..."
      );

      const ffmpeg = spawn(
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

      ffmpeg.stdout.pipe(res);

      ffmpeg.stderr.on(
        "data",
        data => {
          console.error(
            "[FFMPEG AUDIUS STDERR]",
            data.toString().trim()
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

          if (!res.writableEnded) {
            res.end();
          }
        }
      );

      // ------------------------------------------------------
      // WEB STREAM -> FFMPEG STDIN
      // ------------------------------------------------------

      const reader =
        upstream.body.getReader();

      async function pump() {
        try {
          while (true) {
            const {
              done,
              value
            } = await reader.read();

            if (done) {
              console.log(
                "[AUDIUS FETCH] Stream finished"
              );

              ffmpeg.stdin.end();
              break;
            }

            const buffer =
              Buffer.from(value);

            const writable =
              ffmpeg.stdin.write(
                buffer
              );

            if (!writable) {
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
      }

      pump();

    } catch (err) {
      console.error(
        "[AUDIUS TEST ERROR]",
        err
      );

      if (!res.headersSent) {
        res
          .status(500)
          .send(String(err));
      } else {
        res.end();
      }
    }
  }
);

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
      now - track.createdAt >
      60 * 60 * 1000
    ) {
      resolvedTracks.delete(
        token
      );
    }
  }
}, 10 * 60 * 1000);

// ============================================================
// ROUTES READY
// ============================================================

console.log(
  "[ROUTE] /stream_pcm registered"
);

console.log(
  "[ROUTE] /audio/:token.mp3 registered"
);

console.log(
  "[ROUTE] /test-online-search registered"
);

console.log(
  "[ROUTE] /test-audius-play/:trackId registered"
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `YN Music Server V5.1 running on port ${PORT}`
    );

    console.log(
      `[CATALOG] ${catalog.length} local tracks ready`
    );
  }
);
