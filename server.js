import express from "express";

const app = express();
app.set("trust proxy", true);
const PORT = process.env.PORT || 3000;

const TEST_MP3 =
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";

app.get("/", (req, res) => {
  res.json({
    name: "YN Music Server",
    version: "3.0",
    status: "online",
    protocol: "Meow / DB-ROBOT compatible"
  });
});

//
// MP3 proxy
//
app.get("/audio/test.mp3", async (req, res) => {
  try {
    console.log("[AUDIO] ESP32 requested /audio/test.mp3");
    console.log("[AUDIO] UA:", req.headers["user-agent"]);
    console.log("[AUDIO] Range:", req.headers.range || "none");

    const headers = {};

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(TEST_MP3, {
      headers,
      redirect: "follow"
    });

    console.log(
      "[AUDIO] upstream:",
      upstream.status,
      upstream.headers.get("content-type")
    );

    res.status(upstream.status);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache");

    const contentLength =
      upstream.headers.get("content-length");

    const contentRange =
      upstream.headers.get("content-range");

    const acceptRanges =
      upstream.headers.get("accept-ranges");

    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    if (contentRange) {
      res.setHeader("Content-Range", contentRange);
    }

    if (acceptRanges) {
      res.setHeader("Accept-Ranges", acceptRanges);
    }

    if (!upstream.body) {
      return res.end();
    }

    const reader = upstream.body.getReader();

    req.on("close", () => {
      reader.cancel().catch(() => {});
    });

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (!res.write(Buffer.from(value))) {
        await new Promise(resolve =>
          res.once("drain", resolve)
        );
      }
    }

    res.end();

  } catch (err) {
    console.error("[AUDIO ERROR]", err);

    if (!res.headersSent) {
      res.status(500).send("Audio proxy error");
    } else {
      res.end();
    }
  }
});

//
// Endpoint tương thích Meow / DB-ROBOT
//
app.get("/stream_pcm", (req, res) => {

  const song =
    String(req.query.song || "").trim();

  const artist =
    String(
      req.query.artist ||
      req.query.singer ||
      ""
    ).trim();

  const play =
    String(req.query.url || "").toLowerCase();

  console.log("====================================");
  console.log("[DB-ROBOT REQUEST]");
  console.log("Song   :", song);
  console.log("Artist :", artist);
  console.log("url    :", play);
  console.log("UA     :", req.headers["user-agent"]);
  console.log("====================================");

  if (!song) {
    return res.json({
      title: "",
      artist: "",
      audio_url: "",
      audio_full_url: "",
      m3u8_url: "",
      lyric_url: "",
      cover_url: "",
      duration: 0,
      from_cache: false,
      ip: ""
    });
  }

  const base =
  process.env.PUBLIC_URL ||
  "https://ynguyen-music-server.onrender.com";

  const audioURL =
    `${base}/audio/test.mp3`;

  //
  // Quan trọng:
  // DB-ROBOT không yêu cầu url=true.
  // Nó cần MusicItem JSON.
  //
  const musicItem = {
    title: song,
    artist: artist,

    audio_url: audioURL,
    audio_full_url: audioURL,

    m3u8_url: "",
    lyric_url: "",
    cover_url: "",

    duration: 372,

    from_cache: false,
    ip: ""
  };

  console.log("[DB-ROBOT RESPONSE]");
  console.log(JSON.stringify(musicItem));

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  return res.json(musicItem);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `YN Music Server V3 running on port ${PORT}`
  );
});
