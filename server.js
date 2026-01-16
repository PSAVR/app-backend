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
app.set("trust proxy", 1);
const PORT = process.env.PORT || 4000;

const origins = (process.env.CORS_ORIGIN || "http://localhost:5500,http://127.0.0.1:5500")
  .split(",")
  .map(s => s.trim());

app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true); 
    if (origins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true,
}));


const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET no está definido");
}

app.use(express.json());
app.use(cookieParser());
app.options("*", cors());


app.use((req, _res, next) => {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const token = bearer || req.cookies?.token || null;

  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.userId = payload.user_id || payload.uid || payload.userId;
    } catch {
    }
  }
  next();
});



app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/levels", levelRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/colleges", collegeRoutes);


app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () =>
  console.log(`✅ API listening on http://localhost:${PORT}`)
);