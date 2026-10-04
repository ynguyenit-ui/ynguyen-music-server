import express from "express";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";
import crypto from "crypto";


// ============================================================
// APP
// ============================================================

const app = express();

app.set(
  "trust proxy",
  true
);

const PORT =
  process.env.PORT || 3000;


// ============================================================
// CATALOG
// ============================================================

let catalog = [];

try {
  const catalogPath =
    path.join(
      process.cwd(),
      "catalog.json"
    );

  if (
    fs.existsSync(
      catalogPath
    )
  ) {
    catalog =
      JSON.parse(
        fs.readFileSync(
          catalogPath,
          "utf8"
        )
      );

    if (
      !Array.isArray(
        catalog
      )
    ) {
      catalog = [];
    }
  }

} catch (err) {
  console.error(
    "[CATALOG ERROR]",
    err
  );

  catalog = [];
}


console.log(
  `[CATALOG] ${catalog.length} tracks loaded`
);


// ============================================================
// NORMALIZE VIETNAMESE
// ============================================================

function normalize(
  text = ""
) {
  return String(text)
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(
      /[^a-z0-9 ]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


// ============================================================
// WORD HELPERS
// ============================================================

function words(
  text = ""
) {
  const value =
    normalize(text);

  if (!value) {
    return [];
  }

  return value
    .split(" ")
    .filter(Boolean);
}


function wordOverlap(
  a,
  b
) {
  const aa =
    new Set(
      words(a)
    );

  const bb =
    new Set(
      words(b)
    );


  if (
    !aa.size ||
    !bb.size
  ) {
    return 0;
  }


  let matches = 0;

  for (
    const word of aa
  ) {
    if (
      bb.has(word)
    ) {
      matches++;
    }
  }


  return (
    matches /
    Math.max(
      aa.size,
      bb.size
    )
  );
}


function containsWords(
  text,
  wanted
) {
  const textWords =
    new Set(
      words(text)
    );

  const wantedWords =
    words(wanted);


  if (
    !wantedWords.length
  ) {
    return false;
  }


  return wantedWords.every(
    word =>
      textWords.has(word)
  );
}


// ============================================================
// LEVENSHTEIN
// ============================================================

function levenshtein(
  a,
  b
) {
  a = normalize(a);
  b = normalize(b);


  const matrix =
    Array.from(
      {
        length:
          b.length + 1
      },
      () =>
        new Array(
          a.length + 1
        ).fill(0)
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
      const cost =
        b[i - 1] ===
        a[j - 1]
          ? 0
          : 1;


      matrix[i][j] =
        Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] +
            cost
        );
    }
  }


  return matrix[
    b.length
  ][
    a.length
  ];
}


function similarity(
  a,
  b
) {
  a = normalize(a);
  b = normalize(b);


  if (
    !a ||
    !b
  ) {
    return 0;
  }


  if (
    a === b
  ) {
    return 1;
  }


  const maxLength =
    Math.max(
      a.length,
      b.length
    );


  if (!maxLength) {
    return 1;
  }


  return Math.max(
    0,
    1 -
      levenshtein(
        a,
        b
      ) /
        maxLength
  );
}


// ============================================================
// LOCAL TRACK HELPERS
// ============================================================

function getLocalTitle(
  track
) {
  return (
    track.title ||
    track.name ||
    ""
  );
}


function getLocalArtist(
  track
) {
  return (
    track.artist ||
    track.singer ||
    ""
  );
}


function getLocalSourceFile(
  track
) {
  return (
    track.source_file ||
    track.file ||
    track.path ||
    ""
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
  const title =
    getLocalTitle(
      track
    );

  const trackArtist =
    getLocalArtist(
      track
    );


  const titleSimilarity =
    similarity(
      title,
      song
    );


  const titleOverlap =
    wordOverlap(
      title,
      song
    );


  const artistSimilarity =
    artist
      ? similarity(
          trackArtist,
          artist
        )
      : 0;


  let score =
    titleSimilarity * 100 +
    titleOverlap * 50 +
    artistSimilarity * 30;


  if (
    containsWords(
      title,
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


  for (
    const item of catalog
  ) {
    const score =
      scoreLocalTrack(
        item,
        song,
        artist
      );


    console.log(
      `[LOCAL CANDIDATE] ${getLocalTitle(item)} | score=${score.toFixed(1)}`
    );


    if (
      !best ||
      score > best.score
    ) {
      best = {
        ...item,

        title:
          getLocalTitle(
            item
          ),

        artist:
          getLocalArtist(
            item
          ),

        source_file:
          getLocalSourceFile(
            item
          ),

        provider:
          "local",

        score
      };
    }
  }


  if (
    best &&
    best.score >= 70
  ) {
    return best;
  }


  return null;
}


// ============================================================
// AUDIUS SEARCH
// ============================================================

async function searchAudius(
  song,
  artist
) {
  const query =
    [song, artist]
      .filter(Boolean)
      .join(" ");


  console.log(
    "[AUDIUS SEARCH] Query:",
    query
  );


  const url =
    `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&limit=10`;


  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            "application/json",

          "User-Agent":
            "YN-Music-Server/5.3.1"
        }
      }
    );


  console.log(
    "[AUDIUS SEARCH] HTTP:",
    response.status
  );


  if (!response.ok) {
    throw new Error(
      `Audius search HTTP ${response.status}`
    );
  }


  const json =
    await response.json();


  const data =
    Array.isArray(
      json?.data
    )
      ? json.data
      : [];


  return data.map(
    track => ({
      id:
        String(
          track.id || ""
        ),

      title:
        String(
          track.title || ""
        ),

      artist:
        String(
          track.user?.name ||
          track.user?.handle ||
          ""
        ),

      duration:
        Number(
          track.duration || 0
        ),

      genre:
        String(
          track.genre || ""
        ),

      provider:
        "audius"
    })
  );
}


// ============================================================
// AUDIUS SMART RANKING
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


function unwantedVersionPenalty(
  track,
  requestedSong
) {
  const title =
    normalize(
      track.title
    );

  const requested =
    normalize(
      requestedSong
    );


  let penalty = 0;


  for (
    const unwanted of
      UNWANTED_VERSIONS
  ) {
    const normalizedUnwanted =
      normalize(
        unwanted
      );


    const trackHas =
      title.includes(
        normalizedUnwanted
      );


    const requestHas =
      requested.includes(
        normalizedUnwanted
      );


    if (
      trackHas &&
      !requestHas
    ) {
      penalty += 35;
    }
  }


  return penalty;
}


function scoreAudiusTrack(
  track,
  song,
  artist
) {
  let score = 0;


  // ----------------------------------------------------------
  // TITLE FUZZY
  // ----------------------------------------------------------

  const fuzzyTitle =
    similarity(
      track.title,
      song
    );


  score +=
    fuzzyTitle * 100;


  // ----------------------------------------------------------
  // SONG WORD OVERLAP
  // ----------------------------------------------------------

  const songWords =
    wordOverlap(
      track.title,
      song
    );


  score +=
    songWords * 100;


  if (
    containsWords(
      track.title,
      song
    )
  ) {
    score += 80;
  }


  // ----------------------------------------------------------
  // ARTIST
  // ----------------------------------------------------------

  let artistTitleScore = 0;
  let artistUploaderScore = 0;


  if (artist) {

    artistTitleScore =
      wordOverlap(
        track.title,
        artist
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
        track.artist,
        artist
      );


    score +=
      artistUploaderScore * 25;
  }


  // ----------------------------------------------------------
  // REMIX / COVER / KARAOKE PENALTY
  // ----------------------------------------------------------

  const penalty =
    unwantedVersionPenalty(
      track,
      song
    );


  score -= penalty;


  // ----------------------------------------------------------
  // VERY SHORT TRACK PENALTY
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
//
// QUAN TRỌNG:
// DB-ROBOT cần relative audio URL:
// /audio/TOKEN.mp3
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
          true,

        audius_auto_fallback:
          true
      }
    });
  }
);


// ============================================================
// STREAM_PCM
//
// DB-ROBOT:
//
// /stream_pcm?song=...&artist=...
//
// Search order:
//
// 1. Local
// 2. Audius
//
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
    // STEP 1 - LOCAL SEARCH
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
    // STEP 2 - AUDIUS SEARCH
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
      // SAVE ALTERNATIVES FOR AUTO FALLBACK
      //
      // #1 = onlineTrack
      // #2 -> #5 = alternatives
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
//
// DB-ROBOT gọi:
//
// /audio/TOKEN.mp3
//
// ============================================================

app.get(
  "/audio/:token.mp3",
  async (req, res) => {

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
      ""
    );

    console.log(
      "===================================="
    );


    if (!track) {

      console.log(
        "[AUDIO] TOKEN NOT FOUND"
      );


      return res
        .status(404)
        .send(
          "Audio token not found"
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


    // ========================================================
    // LOCAL
    // ========================================================

    if (
      track.provider ===
      "local"
    ) {

      return streamLocalTrack(
        track,
        req,
        res
      );
    }


    // ========================================================
    // AUDIUS
    // ========================================================

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


    console.error(
      "[AUDIO] UNKNOWN PROVIDER:",
      track.provider
    );


    return res
      .status(500)
      .send(
        "Unknown audio provider"
      );
  }
);


// ============================================================
// LOCAL AUDIO
//
// Local file
//      ↓
// FFmpeg
//      ↓
// MP3 mono 24kHz 32kbps
//      ↓
// DB-ROBOT
// ============================================================

function streamLocalTrack(
  track,
  req,
  res
) {

  const sourceFile =
    track.source_file ||
    track.file ||
    track.path ||
    "";


  if (!sourceFile) {

    console.error(
      "[LOCAL AUDIO] Missing source_file"
    );


    return res
      .status(404)
      .send(
        "Local audio file not configured"
      );
  }


  const inputFile =
    path.isAbsolute(
      sourceFile
    )
      ? sourceFile
      : path.join(
          process.cwd(),
          sourceFile
        );


  console.log(
    "[LOCAL AUDIO] File:",
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
        "Local audio file not found"
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


      if (
        !res.headersSent
      ) {

        res
          .status(500)
          .send(
            "FFmpeg local error"
          );
      }
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
// AUDIUS V5.3.1 AUTO FALLBACK
//
// Candidate #1 lỗi
//      ↓
// thử #2
//      ↓
// thử #3
//      ↓
// thử #4/#5
//
// ============================================================

async function probeAudiusTrack(
  track,
  timeoutMs = 10000
) {

  const sourceUrl =
    `https://api.audius.co/v1/tracks/${encodeURIComponent(track.id)}/stream`;


  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );


  console.log(
    `[AUDIUS FALLBACK] Probe: ${track.title} (${track.id})`
  );


  try {

    const response =
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


    clearTimeout(
      timer
    );


    console.log(
      "[AUDIUS FALLBACK] HTTP:",
      response.status
    );


    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    console.log(
      "[AUDIUS FALLBACK] Type:",
      contentType
    );


    if (
      !response.ok ||
      !response.body
    ) {

      try {
        await response.body?.cancel();
      } catch {}


      return false;
    }


    const type =
      contentType
        .toLowerCase();


    // Audius thường trả audio/mpeg.
    // Cho phép thêm application/octet-stream.
    if (
      !type.startsWith(
        "audio/"
      ) &&
      !type.includes(
        "octet-stream"
      )
    ) {

      console.log(
        "[AUDIUS FALLBACK] Invalid content type"
      );


      try {
        await response.body.cancel();
      } catch {}


      return false;
    }


    // Đây chỉ là probe.
    // Đóng connection và fetch lại khi phát.
    try {
      await response.body.cancel();
    } catch {}


    return true;


  } catch (err) {

    clearTimeout(
      timer
    );


    console.error(
      "[AUDIUS FALLBACK] Probe failed:",
      err.message
    );


    return false;
  }
}


// ============================================================
// SELECT WORKING AUDIUS TRACK
// ============================================================

async function selectWorkingAudiusTrack(
  track
) {

  const candidates = [
    {
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
    },

    ...(
      track.alternatives ||
      []
    )
  ];


  const limited =
    candidates.slice(
      0,
      5
    );


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


// ============================================================
// STREAM AUDIUS
//
// Node fetch()
//      ↓
// FFmpeg stdin
//      ↓
// MP3 24kHz mono 32kbps
//      ↓
// ESP32
//
// KHÔNG để FFmpeg mở Audius URL trực tiếp.
// ============================================================

async function streamAudiusTrack(
  track,
  req,
  res
) {

  // ==========================================================
  // FIND WORKING CANDIDATE
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
    // NODE FETCH AUDIUS
    // ========================================================

    const controller =
      new AbortController();


    const timer =
      setTimeout(
        () =>
          controller.abort(),
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


    // Timeout chỉ dùng để chờ response headers.
    // Sau khi fetch đã kết nối thì bỏ timeout,
    // không được abort giữa bài hát.
    clearTimeout(
      timer
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


    let audioStarted =
      false;


    ffmpeg.stdout.on(
      "data",
      () => {

        if (
          !audioStarted
        ) {

          audioStarted =
            true;


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


        if (
          !res.headersSent
        ) {

          res
            .status(502)
            .send(
              "FFmpeg Audius error"
            );
        }
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
      upstream.body
        .getReader();


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


          if (
            !ffmpeg.stdin.destroyed
          ) {

            ffmpeg.stdin.end();
          }


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

      return res
        .status(502)
        .send(
          "Audius audio error"
        );
    }


    if (
      !res.writableEnded
    ) {

      res.end();
    }
  }
}


// ============================================================
// TEST ONLINE SEARCH
//
// Browser:
//
// /test-online-search?song=Lac%20Troi&artist=Son%20Tung
//
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
// V5.4 TEST - JAMENDO SEARCH ONLY
//
// Test:
// /test-jamendo-search?song=Lac%20Troi&artist=Son%20Tung
// ============================================================

app.get(
  "/test-jamendo-search",
  async (req, res) => {

    const song =
      String(
        req.query.song || ""
      ).trim();

    const artist =
      String(
        req.query.artist || ""
      ).trim();


    if (!song) {
      return res
        .status(400)
        .json({
          error: "Missing song"
        });
    }


    const clientId =
      process.env.JAMENDO_CLIENT_ID || "";


    if (!clientId) {

      console.error(
        "[JAMENDO] JAMENDO_CLIENT_ID missing"
      );

      return res
        .status(500)
        .json({
          error:
            "JAMENDO_CLIENT_ID is not configured"
        });
    }


    const query =
      [song, artist]
        .filter(Boolean)
        .join(" ");


    console.log(
      "\n===================================="
    );

    console.log(
      "[JAMENDO TEST SEARCH]"
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
      "Query  :",
      query
    );


    try {

      const params =
        new URLSearchParams({
          client_id:
            clientId,

          format:
            "json",

          limit:
            "20",

          search:
            query,

          audioformat:
            "mp32"
        });


      const jamendoUrl =
        `https://api.jamendo.com/v3.0/tracks/?${params.toString()}`;


      const response =
        await fetch(
          jamendoUrl,
          {
            headers: {
              Accept:
                "application/json",

              "User-Agent":
                "YN-Music-Server/5.4-TEST"
            }
          }
        );


      console.log(
        "[JAMENDO SEARCH] HTTP:",
        response.status
      );


      const text =
        await response.text();


      if (!response.ok) {

        console.error(
          "[JAMENDO SEARCH] HTTP ERROR:",
          text.slice(0, 500)
        );


        return res
          .status(502)
          .json({
            error:
              "Jamendo HTTP error",

            status:
              response.status
          });
      }


      let data;


      try {

        data =
          JSON.parse(text);

      } catch (err) {

        console.error(
          "[JAMENDO SEARCH] Invalid JSON"
        );


        return res
          .status(502)
          .json({
            error:
              "Jamendo returned invalid JSON"
          });
      }


      const results =
        Array.isArray(
          data.results
        )
          ? data.results
          : [];


      console.log(
        "[JAMENDO SEARCH] API status:",
        data.headers?.status
      );

      console.log(
        "[JAMENDO SEARCH] Results:",
        results.length
      );


      const tracks =
        results.map(
          track => ({
            id:
              track.id || "",

            title:
              track.name || "",

            artist:
              track.artist_name || "",

            album:
              track.album_name || "",

            duration:
              Number(
                track.duration || 0
              ),

            audio:
              track.audio || "",

            shareurl:
              track.shareurl || ""
          })
        );


      return res.json({
        provider:
          "jamendo",

        query,

        count:
          tracks.length,

        api_status:
          data.headers?.status,

        api_error:
          data.headers?.error_message || "",

        tracks
      });


    } catch (err) {

      console.error(
        "[JAMENDO SEARCH ERROR]",
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
// V5.4A TEST - AUDIUS MULTI SEARCH
//
// Test:
// /test-audius-multisearch?song=Lac%20Troi&artist=Son%20Tung%20M-TP
// ============================================================

app.get("/test-audius-multisearch", async (req, res) => {

  const song = String(req.query.song || "").trim();
  const artist = String(req.query.artist || "").trim();

  if (!song) {
    return res.status(400).json({
      error: "Missing song"
    });
  }

  // Tạo nhiều cách tìm khác nhau
  const queries = [
    `${song} ${artist}`,
    `${normalize(song)} ${normalize(artist)}`,
    song,
    normalize(song),
    artist ? `${artist} ${song}` : "",
    artist
      ? `${normalize(artist)} ${normalize(song)}`
      : ""
  ]
    .map(x => x.trim())
    .filter(Boolean);

  // Loại query trùng
  const uniqueQueries = [
    ...new Map(
      queries.map(q => [
        normalize(q),
        q
      ])
    ).values()
  ];

  console.log(
    "\n===================================="
  );

  console.log(
    "[AUDIUS MULTI SEARCH]"
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
    "Queries:",
    uniqueQueries
  );

  try {

    const allTracks = [];

    for (const query of uniqueQueries) {

      console.log(
        "[AUDIUS MULTI] Searching:",
        query
      );

      const params =
        new URLSearchParams({
          query,
          limit: "20",
          offset: "0",
          sort_method: "relevant"
        });

      const url =
        `https://api.audius.co/v1/tracks/search?${params.toString()}`;

      const response =
        await fetch(url, {
          headers: {
            Accept:
              "application/json",

            "User-Agent":
              "YN-Music-Server/5.4A-TEST"
          }
        });

      console.log(
        "[AUDIUS MULTI] HTTP:",
        response.status
      );

      if (!response.ok) {
        continue;
      }

      const data =
        await response.json();

      const results =
        Array.isArray(data.data)
          ? data.data
          : [];

      console.log(
        "[AUDIUS MULTI] Found:",
        results.length
      );

      for (const track of results) {

        allTracks.push({
          id:
            track.id || "",

          title:
            track.title || "",

          artist:
            track.user?.name ||
            track.user?.handle ||
            "",

          duration:
            Number(
              track.duration || 0
            ),

          genre:
            track.genre || "",

          query_found:
            query
        });
      }
    }


    // ----------------------------------------
    // REMOVE DUPLICATES BY TRACK ID
    // ----------------------------------------

    const trackMap =
      new Map();

    for (const track of allTracks) {

      if (!track.id) {
        continue;
      }

      if (!trackMap.has(track.id)) {

        trackMap.set(
          track.id,
          {
            ...track,
            found_count: 1,
            found_queries: [
              track.query_found
            ]
          }
        );

      } else {

        const existing =
          trackMap.get(track.id);

        existing.found_count++;

        if (
          !existing.found_queries.includes(
            track.query_found
          )
        ) {
          existing.found_queries.push(
            track.query_found
          );
        }
      }
    }


    const uniqueTracks =
      [...trackMap.values()];


    // ----------------------------------------
    // SCORE
    // ----------------------------------------

    const ranked =
      uniqueTracks.map(track => {

        const title =
          normalize(track.title);

        const uploader =
          normalize(track.artist);

        const wantedSong =
          normalize(song);

        const wantedArtist =
          normalize(artist);


        let score = 0;


        // Title similarity
        score +=
          similarity(
            title,
            wantedSong
          ) * 100;


        // Song word overlap
        score +=
          wordOverlap(
            title,
            wantedSong
          ) * 100;


        // Full song words inside title
        if (
          containsWords(
            title,
            wantedSong
          )
        ) {
          score += 100;
        }


        // Artist
        if (wantedArtist) {

          score +=
            wordOverlap(
              title,
              wantedArtist
            ) * 80;

          score +=
            similarity(
              uploader,
              wantedArtist
            ) * 30;

          if (
            containsWords(
              title,
              wantedArtist
            )
          ) {
            score += 80;
          }
        }


        // Track xuất hiện ở nhiều query
        score +=
          Math.min(
            track.found_count * 15,
            75
          );


        // Penalize remix / cover etc.
        const combined =
          `${title} ${uploader}`;

        for (
          const bad of
          UNWANTED_VERSIONS
        ) {

          if (
            combined.includes(
              normalize(bad)
            ) &&
            !normalize(
              `${song} ${artist}`
            ).includes(
              normalize(bad)
            )
          ) {
            score -= 50;
          }
        }


        // Track quá ngắn
        if (
          track.duration > 0 &&
          track.duration < 60
        ) {
          score -= 60;
        }


        return {
          ...track,

          score:
            Math.round(score)
        };
      });


    ranked.sort(
      (a, b) =>
        b.score - a.score
    );


    console.log(
      "[AUDIUS MULTI] Unique tracks:",
      ranked.length
    );


    console.log(
      "[AUDIUS MULTI] TOP 5:"
    );


    ranked
      .slice(0, 5)
      .forEach(
        (track, index) => {

          console.log(
            `#${index + 1}`,
            track.score,
            track.title,
            "-",
            track.artist,
            `(found ${track.found_count}x)`
          );
        }
      );


    return res.json({

      version:
        "5.4A-test",

      song,

      artist,

      queries:
        uniqueQueries,

      raw_results:
        allTracks.length,

      unique_results:
        ranked.length,

      top:
        ranked.slice(0, 20)

    });


  } catch (err) {

    console.error(
      "[AUDIUS MULTI ERROR]",
      err
    );


    return res
      .status(500)
      .json({
        error:
          String(err)
      });
  }
});
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
console.log(
  "[ROUTE] /test-jamendo-search registered"
);
console.log(
  "[ROUTE] /test-audius-multisearch registered"
);
// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `YN Music Server V5.3.1 CLEAN running on port ${PORT}`
    );


    console.log(
      `[CATALOG] ${catalog.length} local tracks ready`
    );


    console.log(
      "[SEARCH] Local -> Audius Smart Ranking"
    );


    console.log(
      "[FALLBACK] Audius Auto Fallback enabled"
    );


    console.log(
      "[AUDIO] Node fetch -> FFmpeg stdin enabled"
    );
  }
);
