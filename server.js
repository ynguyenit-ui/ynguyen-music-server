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
// YN MUSIC SERVER V5.3
//
// SEARCH:
//   LOCAL -> AUDIUS SMART RANKING
//
// AUDIO:
//   LOCAL  -> FFmpeg -> ESP32
//   AUDIUS -> Node fetch -> FFmpeg stdin -> ESP32
//
// DB-ROBOT OUTPUT:
//   MP3 / MONO / 24000 Hz / 32 kbps
// ============================================================


// ============================================================
// CATALOG
// ============================================================

let catalog = [];

try {
  catalog = JSON.parse(
    fs.readFileSync("./catalog.json", "utf8")
  );

  console.log(
    `[CATALOG] Loaded ${catalog.length} tracks`
  );

} catch (err) {
  console.error(
    "[CATALOG ERROR]",
    err
  );
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
// WORD HELPERS
// ============================================================

function words(text = "") {
  return normalize(text)
    .split(" ")
    .filter(Boolean);
}


function wordOverlap(a, b) {
  const aWords = words(a);
  const bWords = new Set(words(b));

  if (!aWords.length) {
    return 0;
  }

  let matches = 0;

  for (const word of aWords) {
    if (bWords.has(word)) {
      matches++;
    }
  }

  return matches / aWords.length;
}


function containsWords(text, wanted) {
  const haystack =
    new Set(words(text));

  const needles =
    words(wanted);

  if (!needles.length) {
    return false;
  }

  return needles.every(
    word => haystack.has(word)
  );
}


// ============================================================
// LEVENSHTEIN
// ============================================================

function levenshtein(a, b) {
  const matrix = Array.from(
    { length: b.length + 1 },
    () =>
      Array(a.length + 1).fill(0)
  );

  for (
    let i = 0;
    i <= b.length;
    i++
  ) {
    matrix[i][0] = i;
  }

  for (
    let j = 0;
    j <= a.length;
    j++
  ) {
    matrix[0][j] = j;
  }

  for (
    let i = 1;
    i <= b.length;
    i++
  ) {
    for (
      let j = 1;
      j <= a.length;
      j++
    ) {
      if (
        b[i - 1] ===
        a[j - 1]
      ) {
        matrix[i][j] =
          matrix[i - 1][j - 1];
      } else {
        matrix[i][j] =
          Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
      }
    }
  }

  return matrix[b.length][a.length];
}


// ============================================================
// SIMILARITY
// ============================================================

function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  const distance =
    levenshtein(a, b);

  const maxLength =
    Math.max(
      a.length,
      b.length
    );

  if (!maxLength) {
    return 0;
  }

  return (
    1 -
    distance / maxLength
  );
}


// ============================================================
// LOCAL SEARCH
// ============================================================

function scoreLocalTrack(
  track,
  song,
  artist
) {
  const titleScore =
    similarity(
      song,
      track.title
    );

  const wordScore =
    wordOverlap(
      song,
      track.title
    );

  let artistScore = 0;

  if (
    artist &&
    track.artist
  ) {
    artistScore =
      similarity(
        artist,
        track.artist
      );
  }

  let score =
    titleScore * 100;

  score +=
    wordScore * 50;

  score +=
    artistScore * 30;

  if (
    containsWords(
      track.title,
      song
    )
  ) {
    score += 30;
  }

  return score;
}


function findLocalTrack(
  song,
  artist
) {
  let best = null;
  let bestScore = 0;

  for (
    const track of catalog
  ) {
    const score =
      scoreLocalTrack(
        track,
        song,
        artist
      );

    console.log(
      `[LOCAL CANDIDATE] ` +
      `${track.title} | ` +
      `score=${score.toFixed(1)}`
    );

    if (
      score > bestScore
    ) {
      bestScore = score;
      best = track;
    }
  }

  // Fuzzy threshold.
  // Cho phép trường hợp:
  // "Kẻ Sai Tình 2"
  // nhận nhầm từ
  // "Kẻ Say Tình 2"

  if (
    !best ||
    bestScore < 70
  ) {
    return null;
  }

  return {
    ...best,

    provider:
      "local",

    score:
      Math.round(
        bestScore
      )
  };
}


// ============================================================
// AUDIUS SEARCH
// ============================================================

async function searchAudius(
  song,
  artist = ""
) {
  const query =
    [song, artist]
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

  const response =
    await fetch(
      url,
      {
        redirect:
          "follow",

        headers: {
          Accept:
            "application/json",

          "User-Agent":
            "YN-Music-Server/5.3"
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

  return (
    json.data || []
  ).map(
    track => ({
      id:
        track.id,

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

      provider:
        "audius"
    })
  );
}


// ============================================================
// V5.3 - UNWANTED VERSION DETECTION
// ============================================================

const UNWANTED_VERSIONS = [
  "remix",
  "cover",
  "karaoke",
  "instrumental",
  "sped up",
  "speed up",
  "slowed",
  "reverb",
  "nightcore",
  "8d",
  "mashup"
];


function requestedSpecialVersion(
  song
) {
  const n =
    normalize(song);

  return (
    UNWANTED_VERSIONS.some(
      word =>
        n.includes(word)
    )
  );
}


function unwantedVersionPenalty(
  track,
  song
) {
  // Nếu user nói rõ:
  // "Lạc Trôi remix"
  // thì remix KHÔNG bị phạt.

  if (
    requestedSpecialVersion(
      song
    )
  ) {
    return 0;
  }

  const title =
    normalize(
      track.title
    );

  let penalty = 0;

  for (
    const word of
    UNWANTED_VERSIONS
  ) {
    if (
      title.includes(word)
    ) {
      penalty += 35;
    }
  }

  return penalty;
}


// ============================================================
// V5.3 - SMART AUDIUS SCORE
// ============================================================

function scoreAudiusTrack(
  track,
  song,
  artist
) {
  const requestedSong =
    normalize(song);

  const requestedArtist =
    normalize(artist);

  const trackTitle =
    normalize(
      track.title
    );

  const uploader =
    normalize(
      track.artist
    );

  let score = 0;

  // ----------------------------------------------------------
  // 1. Fuzzy title similarity
  // ----------------------------------------------------------

  const fuzzyTitle =
    similarity(
      requestedSong,
      trackTitle
    );

  score +=
    fuzzyTitle * 100;


  // ----------------------------------------------------------
  // 2. Song word overlap
  //
  // Ví dụ:
  // requested = Lac Troi
  // result    = Lac Troi - Son Tung M-TP
  // ----------------------------------------------------------

  const songWords =
    wordOverlap(
      song,
      track.title
    );

  score +=
    songWords * 100;


  // ----------------------------------------------------------
  // 3. Full song words exist in result title
  // ----------------------------------------------------------

  if (
    requestedSong &&
    containsWords(
      track.title,
      song
    )
  ) {
    score += 80;
  }


  // ----------------------------------------------------------
  // 4. Artist ranking
  //
  // Audius uploader có thể không phải ca sĩ.
  //
  // Ví dụ:
  // title    = Lac Troi - Son Tung M-TP
  // uploader = Toronono
  //
  // Artist trong TITLE quan trọng hơn uploader.
  // ----------------------------------------------------------

  let artistTitleScore = 0;
  let artistUploaderScore = 0;

  if (requestedArtist) {
    artistTitleScore =
      wordOverlap(
        artist,
        track.title
      );

    score +=
      artistTitleScore * 80;

    if (
      containsWords(
        track.title,
        artist
      )
    ) {
      score += 80;
    }

    artistUploaderScore =
      similarity(
        requestedArtist,
        uploader
      );

    score +=
      artistUploaderScore * 25;
  }


  // ----------------------------------------------------------
  // 5. Penalty:
  // remix / cover / karaoke / etc.
  // ----------------------------------------------------------

  const penalty =
    unwantedVersionPenalty(
      track,
      song
    );

  score -= penalty;


  // ----------------------------------------------------------
  // 6. Very short audio penalty
  // ----------------------------------------------------------

  if (
    track.duration > 0 &&
    track.duration < 60
  ) {
    score -= 50;
  }


  return {
    score,
    fuzzyTitle,
    songWords,
    artistTitleScore,
    artistUploaderScore,
    penalty
  };
}


// ============================================================
// V5.3 - RANK AUDIUS RESULTS
// ============================================================

function chooseAudiusTracks(
  tracks,
  song,
  artist
) {
  const ranked = [];

  for (
    const track of tracks
  ) {
    const result =
      scoreAudiusTrack(
        track,
        song,
        artist
      );

    ranked.push({
      ...track,

      score:
        Math.round(
          result.score
        ),

      _debug:
        result
    });
  }


  ranked.sort(
    (a, b) =>
      b.score -
      a.score
  );


  console.log(
    "\n[AUDIUS RANKING]"
  );

  ranked.forEach(
    (track, index) => {
      console.log(
        `#${index + 1}`,
        `score=${track.score}`,
        `| ${track.title}`,
        `| uploader=${track.artist}`,
        `| duration=${track.duration}`,
        `| penalty=${track._debug.penalty}`
      );
    }
  );


  return ranked;
}


// ============================================================
// TOKEN CACHE
// ============================================================

const resolvedTracks =
  new Map();


function createToken(
  track
) {
  const token =
    crypto
      .randomBytes(8)
      .toString("hex");

  resolvedTracks.set(
    token,
    {
      ...track,
      createdAt:
        Date.now()
    }
  );

  return token;
}


// ============================================================
// MUSIC ITEM
// ============================================================

function makeMusicItem(
  track,
  token
) {
  const audioPath =
    `/audio/${token}.mp3`;

  return {
    title:
      track.title || "",

    artist:
      track.artist || "",

    audio_url:
      audioPath,

    audio_full_url:
      audioPath,

    m3u8_url:
      "",

    lyric_url:
      "",

    cover_url:
      "",

    duration:
      track.duration || 0,

    from_cache:
      track.provider ===
      "local",

    ip:
      ""
  };
}


// ============================================================
// STATUS
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      name:
        "YN Music Server",

      version:
        "5.3.1",

      status:
        "online",

      local_tracks:
        catalog.length,

      search_order: [
        "local",
        "audius-smart-ranking"
      ],

      audio: {
        codec:
          "MP3",

        channels:
          1,

        sample_rate:
          24000,

        bitrate:
          "32k"
      },

      features: {
        local_fuzzy_search:
          true,

        audius_search:
          true,

        smart_ranking:
          true,

        unwanted_version_penalty:
          true,

        alternatives_cache:
          true
      }
    });
  }
);


// ============================================================
// DB-ROBOT SEARCH
//
// 1. LOCAL
// 2. AUDIUS SMART SEARCH
// ============================================================

app.get(
  "/stream_pcm",
  async (req, res) => {

    const song =
      String(
        req.query.song ||
        ""
      ).trim();

    const artist =
      String(
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
      req.query.url ||
      ""
    );

    console.log(
      "UA     :",
      req.headers[
        "user-agent"
      ] || ""
    );

    console.log(
      "===================================="
    );


    if (!song) {
      return res
        .status(400)
        .json({
          error:
            "Missing song"
        });
    }


    // ========================================================
    // STEP 1: LOCAL SEARCH
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
        "Requested:",
        song
      );

      console.log(
        "Matched  :",
        localTrack.title
      );

      console.log(
        "Score    :",
        localTrack.score
      );


      const token =
        createToken(
          localTrack
        );


      const musicItem =
        makeMusicItem(
          localTrack,
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
    }


    console.log(
      "[LOCAL] NOT FOUND"
    );


    // ========================================================
    // STEP 2: AUDIUS SEARCH
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


      if (
        !results.length
      ) {
        console.log(
          "[AUDIUS] NO RESULTS"
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


      // ======================================================
      // SMART RANKING
      // ======================================================

      const rankedTracks =
        chooseAudiusTracks(
          results,
          song,
          artist
        );


      const onlineTrack =
        rankedTracks[0];


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
        "\n[AUDIUS] MATCH"
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


      // ======================================================
      // SAVE TOP ALTERNATIVES
      //
      // V5.3 chuẩn bị sẵn cho auto fallback.
      // ======================================================

      const alternatives =
        rankedTracks
          .slice(1, 5)
          .map(
            track => ({
              id:
                track.id,

              title:
                track.title,

              artist:
                track.artist,

              duration:
                track.duration,

              genre:
                track.genre,

              provider:
                "audius",

              score:
                track.score
            })
          );


      const token =
        createToken({
          ...onlineTrack,

          provider:
            "audius",

          alternatives
        });


      console.log(
        "[AUDIUS] Alternatives cached:",
        alternatives.length
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
      req.headers[
        "user-agent"
      ] || ""
    );

    console.log(
      "Range    :",
      req.headers.range ||
      "none"
    );

    console.log(
      "===================================="
    );


    if (!track) {

      console.log(
        "[AUDIO] UNKNOWN TOKEN"
      );

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


    console.log(
      "[AUDIO] Title:",
      track.title
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
//
// FILE -> FFMPEG -> ESP32
// ============================================================

function streamLocalTrack(
  track,
  req,
  res
) {

  if (
    !track.source_file
  ) {

    console.error(
      "[LOCAL AUDIO] source_file missing"
    );

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
      "[LOCAL AUDIO] FILE NOT FOUND:",
      inputFile
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


  console.log(
    "[FFMPEG LOCAL] PID:",
    ffmpeg.pid
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
    "error",
    err => {

      console.error(
        "[FFMPEG LOCAL ERROR]",
        err
      );
    }
  );


  ffmpeg.on(
    "exit",
    (
      code,
      signal
    ) => {

      console.log(
        "[FFMPEG LOCAL] EXIT",
        "code =",
        code,
        "signal =",
        signal
      );
    }
  );


  ffmpeg.on(
    "close",
    (
      code,
      signal
    ) => {

      console.log(
        "[FFMPEG LOCAL] CLOSE",
        "code =",
        code,
        "signal =",
        signal
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
// IMPORTANT:
// FFmpeg KHÔNG mở URL Audius trực tiếp.
//
// Audius HTTPS
//      ↓
// Node fetch()
//      ↓
// FFmpeg stdin
//      ↓
// MP3 mono / 24kHz / 32kbps
//      ↓
// DB-ROBOT
//
// Cách này tránh SIGSEGV đã gặp ở V5.1.
// ============================================================
// ============================================================
// V5.3.1 - AUDIUS AUTO FALLBACK
// ============================================================

async function probeAudiusTrack(track, timeoutMs = 10000) {
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

    if (!res.headersSent) {
      return res
        .status(502)
        .send(
          "Audius audio error"
        );
    }

    res.end();
  }
}


// ============================================================
// TEST ONLINE SEARCH
//
// Browser:
// /test-online-search?song=Lac%20Troi&artist=Son%20Tung
// ============================================================

app.get(
  "/test-online-search",
  async (req, res) => {

    const song =
      String(
        req.query.song ||
        ""
      ).trim();


    const artist =
      String(
        req.query.artist ||
        ""
      ).trim();


    if (!song) {

      return res
        .status(400)
        .json({
          error:
            "Missing song"
        });
    }


    try {

      const results =
        await searchAudius(
          song,
          artist
        );


      const ranked =
        chooseAudiusTracks(
          results,
          song,
          artist
        );


      return res.json({
        query:
          [song, artist]
            .filter(Boolean)
            .join(" "),

        count:
          ranked.length,

        tracks:
          ranked.map(
            track => ({
              id:
                track.id,

              title:
                track.title,

              artist:
                track.artist,

              duration:
                track.duration,

              genre:
                track.genre,

              score:
                track.score
            })
          )
      });


    } catch (err) {

      console.error(
        "[ONLINE SEARCH TEST ERROR]",
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
// TOKEN CLEANUP
// ============================================================

setInterval(
  () => {

    const now =
      Date.now();


    for (
      const [
        token,
        track
      ]
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

  },

  10 * 60 * 1000
);


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


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `YN Music Server V5.3.1 running on port ${PORT}`
    );


    console.log(
      `[CATALOG] ${catalog.length} local tracks ready`
    );


    console.log(
      "[SEARCH] Local -> Audius Smart Ranking"
    );


    console.log(
      "[AUDIO] Node fetch -> FFmpeg stdin enabled"
    );
  }
);

  try {
    const response = await fetch(
      sourceUrl,
      {
        redirect: "follow",

        headers: {
          Accept: "*/*",
          "User-Agent": "YN-Music-Server/5.3.1"
        },

        signal: controller.signal
      }
    );

    clearTimeout(timer);

    console.log(
      `[AUDIUS FALLBACK] HTTP ${response.status}`
    );

    if (!response.ok || !response.body) {
      try {
        await response.body?.cancel();
      } catch {}

      return false;
    }

    const contentType =
      response.headers.get("content-type") || "";

    console.log(
      `[AUDIUS FALLBACK] Type: ${contentType}`
    );

    // Chỉ cần xác nhận server thực sự trả audio.
    if (
      !contentType.toLowerCase().includes("audio")
    ) {
      try {
        await response.body.cancel();
      } catch {}

      return false;
    }

    // Probe xong, không dùng connection này để phát.
    try {
      await response.body.cancel();
    } catch {}

    return true;

  } catch (err) {
    clearTimeout(timer);

    console.log(
      `[AUDIUS FALLBACK] Probe failed: ${err.message}`
    );

    return false;
  }
}


async function selectWorkingAudiusTrack(track) {
  const candidates = [
    {
      id: track.id,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      genre: track.genre,
      provider: "audius",
      score: track.score
    },

    ...(track.alternatives || [])
  ];

  // Tối đa 5 kết quả.
  const limited =
    candidates.slice(0, 5);

  console.log(
    `[AUDIUS FALLBACK] ${limited.length} candidates available`
  );

  for (
    let i = 0;
    i < limited.length;
    i++
  ) {
    const candidate =
      limited[i];

    console.log(
      `\n[AUDIUS FALLBACK] TRY #${i + 1}`
    );

    console.log(
      "ID     :",
      candidate.id
    );

    console.log(
      "Title  :",
      candidate.title
    );

    console.log(
      "Artist :",
      candidate.artist
    );

    console.log(
      "Score  :",
      candidate.score
    );

    const working =
      await probeAudiusTrack(
        candidate
      );

    if (working) {
      console.log(
        `[AUDIUS FALLBACK] SELECTED #${i + 1}: ${candidate.title}`
      );

      return candidate;
    }

    console.log(
      `[AUDIUS FALLBACK] FAILED #${i + 1}`
    );
  }

  return null;
}
async function streamAudiusTrack(
  track,
  req,
  res
) {
  // ==========================================================
  // STEP 1 - FIND A WORKING AUDIUS CANDIDATE
  // ==========================================================

  const selected =
    await selectWorkingAudiusTrack(
      track
    );

  if (!selected) {
    console.error(
      "[AUDIUS FALLBACK] ALL CANDIDATES FAILED"
    );

    return res
      .status(502)
      .send(
        "No working Audius source"
      );
  }


  const sourceUrl =
    `https://api.audius.co/v1/tracks/${encodeURIComponent(selected.id)}/stream`;


  console.log(
    "\n[AUDIUS AUDIO] SELECTED"
  );

  console.log(
    "ID     :",
    selected.id
  );

  console.log(
    "Title  :",
    selected.title
  );

  console.log(
    "Artist :",
    selected.artist
  );

  console.log(
    "Source :",
    sourceUrl
  );


  try {
    // ========================================================
    // NODE FETCHES SELECTED AUDIUS SOURCE
    // ========================================================

    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        15000
      );


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
              "YN-Music-Server/5.3.1"
          },

          signal:
            controller.signal
        }
      );


    clearTimeout(timer);


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
        "[AUDIUS FETCH] FAILED AFTER PROBE"
      );

      return res
        .status(502)
        .send(
          "Audius stream failed"
        );
    }


    // ========================================================
    // RESPONSE TO DB-ROBOT
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
    // FFMPEG
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


    let audioStarted = false;


    ffmpeg.stdout.on(
      "data",
      () => {
        if (!audioStarted) {
          audioStarted = true;

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
      (
        code,
        signal
      ) => {
        console.log(
          "[FFMPEG AUDIUS] EXIT",
          "code =",
          code,
          "signal =",
          signal
        );
      }
    );


    ffmpeg.on(
      "close",
      (
        code,
        signal
      ) => {
        console.log(
          "[FFMPEG AUDIUS] CLOSE",
          "code =",
          code,
          "signal =",
          signal
        );

        if (
          !res.writableEnded
        ) {
          res.end();
        }
      }
    );


    // ========================================================
    // AUDIUS -> FFMPEG STDIN
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

  } catch (err) {
    console.error(
      "[AUDIUS AUDIO ERROR]",
      err
    );

    if (!res.headersSent) {
      return res
        .status(502)
        .send(
          "Audius audio error"
        );
    }

    res.end();
  }
}

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
    // NODE FETCHES AUDIUS
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
              "YN-Music-Server/5.3"
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
    // FFMPEG
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
      (
        code,
        signal
      ) => {

        console.log(
          "[FFMPEG AUDIUS] EXIT",
          "code =",
          code,
          "signal =",
          signal
        );
      }
    );


    ffmpeg.on(
      "close",
      (
        code,
        signal
      ) => {

        console.log(
          "[FFMPEG AUDIUS] CLOSE",
          "code =",
          code,
          "signal =",
          signal
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
// TEST ONLINE SEARCH
//
// Browser:
// /test-online-search?song=Lac%20Troi&artist=Son%20Tung
// ============================================================

app.get(
  "/test-online-search",
  async (req, res) => {

    const song =
      String(
        req.query.song ||
        ""
      ).trim();


    const artist =
      String(
        req.query.artist ||
        ""
      ).trim();


    if (!song) {

      return res
        .status(400)
        .json({
          error:
            "Missing song"
        });
    }


    try {

      const results =
        await searchAudius(
          song,
          artist
        );


      const ranked =
        chooseAudiusTracks(
          results,
          song,
          artist
        );


      return res.json({
        query:
          [song, artist]
            .filter(Boolean)
            .join(" "),

        count:
          ranked.length,

        tracks:
          ranked.map(
            track => ({
              id:
                track.id,

              title:
                track.title,

              artist:
                track.artist,

              duration:
                track.duration,

              genre:
                track.genre,

              score:
                track.score
            })
          )
      });


    } catch (err) {

      console.error(
        "[ONLINE SEARCH TEST ERROR]",
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
// TOKEN CLEANUP
// ============================================================

setInterval(
  () => {

    const now =
      Date.now();


    for (
      const [
        token,
        track
      ]
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

  },

  10 * 60 * 1000
);


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


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `YN Music Server V5.3.1 running on port ${PORT}`
    );


    console.log(
      `[CATALOG] ${catalog.length} local tracks ready`
    );


    console.log(
      "[SEARCH] Local -> Audius Smart Ranking"
    );


    console.log(
      "[AUDIO] Node fetch -> FFmpeg stdin enabled"
    );
  }
);
