import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// MP3 công khai dùng riêng để test đường truyền/decoder.
// Có thể thay TEST_MP3_URL bằng file MP3 bạn sở hữu.
const TEST_MP3_URL =
  process.env.TEST_MP3_URL || "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";

app.get("/", (req, res) => {
  res.json({
    name: "YN Music Server",
    version: "2.0",
    status: "online",
    endpoints: {
      test: "/test.mp3",
      stream: "/stream_pcm?song=Test"
    }
  });
});

// Proxy MP3 để kiểm tra ESP32 có decode MP3 được không
async function proxyMp3(req, res, url) {
  try {
    console.log("[AUDIO] Fetch:", url);

    const headers = {};

    // ESP32/audio player đôi khi gửi Range.
    if (req.headers.range) {
      headers.Range = req.headers.range;
      console.log("[AUDIO] Range:", req.headers.range);
    }

    const upstream = await fetch(url, {
      headers,
      redirect: "follow"
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error("[AUDIO] Upstream error:", upstream.status);
      return res.status(502).send("Audio upstream error");
    }

    console.log(
      `[AUDIO] upstream=${upstream.status} type=${upstream.headers.get("content-type")}`
    );

    // Quan trọng cho decoder MP3 của ESP32
    res.status(upstream.status);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache");

    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges");

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
      return res.status(502).end();
    }

    // Node fetch trả Web ReadableStream.
    const reader = upstream.body.getReader();

    req.on("close", () => {
      reader.cancel().catch(() => {});
    });

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (!res.write(Buffer.from(value))) {
        await new Promise(resolve => res.once("drain", resolve));
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
}

// Test trực tiếp
app.get("/test.mp3", async (req, res) => {
  console.log("[TEST] MP3 requested");
  await proxyMp3(req, res, TEST_MP3_URL);
});

// Endpoint mà firmware DB-ROBOT gọi
app.get("/stream_pcm", async (req, res) => {
  const song = String(req.query.song || "").trim();
  const artist = String(req.query.artist || "").trim();

  console.log("====================================");
  console.log("[XIAOZHI]");
  console.log("Song   :", song);
  console.log("Artist :", artist);
  console.log("IP     :", req.ip);
  console.log("UA     :", req.headers["user-agent"]);
  console.log("Range  :", req.headers.range || "none");
  console.log("====================================");

  if (!song) {
    return res.status(400).send("Missing song");
  }

  // V2: bất kể Xiaozhi yêu cầu bài nào,
  // tạm phát cùng một MP3 để kiểm tra firmware.
  await proxyMp3(req, res, TEST_MP3_URL);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`YN Music Server V2 running on port ${PORT}`);
});
