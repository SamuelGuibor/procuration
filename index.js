const express = require("express");
const libre = require("libreoffice-convert");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.CONVERTER_API_KEY || "";

app.use(express.raw({ type: "application/octet-stream", limit: "20mb" }));

app.post("/convert", (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: "No file provided" });
  }

  libre.convert(req.body, "pdf", undefined, (err, result) => {
    if (err) {
      console.error("Conversion error:", err);
      return res.status(500).json({ error: "Conversion failed" });
    }

    res.set("Content-Type", "application/pdf");
    res.send(result);
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`docx-converter running on port ${PORT}`);
});
