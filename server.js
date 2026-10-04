import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// Trang kiểm tra server
app.get("/", (req, res) => {
  res.json({
    name: "YN Music Server",
    status: "online",
    message: "Xiaozhi music backend is running"
  });
});

// Endpoint dành cho firmware DB-ROBOT
app.get("/stream_pcm", async (req, res) => {
  const song = String(req.query.song || "").trim();
  const artist = String(req.query.artist || "").trim();

  console.log(`[XIAOZHI] song="${song}" artist="${artist}"`);

  if (!song) {
    return res.status(400).json({
      error: "Missing song parameter"
    });
  }

  // Hiện tại chỉ kiểm tra kết nối.
  // Bước tiếp theo sẽ thay phần này bằng tìm kiếm + MP3 stream.
  return res.status(404).json({
    status: "provider_not_configured",
    song,
    artist
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`YN Music Server running on port ${PORT}`);
});
