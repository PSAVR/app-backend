import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import levelRoutes from "./routes/levelRoutes.js";
import sessionRoutes from "./routes/sessionRoutes.js";
import collegeRoutes from "./routes/collegeRoutes.js";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5500";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const upload = multer({ dest: "uploads/" });

app.use(cors({
  origin: [ORIGIN, "http://127.0.0.1:5500"],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());


app.use((req, _res, next) => {
  let token = req.cookies?.token || null;
  const auth = req.headers.authorization;
  if (!token && auth?.startsWith("Bearer ")) token = auth.slice(7);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.userId = payload.user_id || payload.uid || payload.userId;
    } catch {
      console.warn("⚠️ Token inválido o expirado");
    }
  }
  next();
});

export function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: "no token" });
  next();
}


app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/levels", levelRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/colleges", collegeRoutes);


app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () =>
  console.log(`✅ API listening on http://localhost:${PORT}`)
);