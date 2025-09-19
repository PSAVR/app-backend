import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { query } from "../db.js";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const FRONT_URL  = process.env.FRONT_URL;


function requireAuth(req, res, next) {
  try {
    const token =
      req.cookies?.token || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (!token) return res.status(401).json({ error: 'no token' });
    const dec = jwt.verify(token, JWT_SECRET);
    req.userId = dec.user_id; 
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await query(`SELECT * FROM "user" WHERE email=$1`, [email]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

  const token = jwt.sign({ user_id: user.user_id }, JWT_SECRET, { expiresIn: "7d" });
    res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",          // ensure sent to all routes
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({ user_id: user.user_id, email: user.email, username: user.username });
});

// =============== REGISTRO ==================
router.post("/register", async (req, res) => {
  const { email, password, username, college, birthdate, gender } = req.body;

  const exists = await query(
    `SELECT 1 FROM "user" WHERE email=$1 OR username=$2 LIMIT 1`,
    [email, username]
  );
  if (exists.rows.length) {
    return res.status(409).json({ error: 'email o username ya registrados' });
  }

  const hash = await bcrypt.hash(password, 10);

  const result = await query(
    `INSERT INTO "user"(email,password,username,college,birthdate,gender)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING user_id,email,username, created_at`,
    [email, hash, username, college, birthdate, gender]
  );
  
  const token = jwt.sign({ user_id: result.rows[0].user_id }, JWT_SECRET, { expiresIn: "7d" });

  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7*24*60*60*1000
  });
  res.status(201).json(result.rows[0]);
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const sql = `
      SELECT 
        u.user_id,
        u.email,
        u.username,
        u.created_at,
        u.current_level_id,
        u.gender,
        COALESCE(u.college, c.college_name) AS college,  -- nombre legible
        u.birthdate
      FROM "user" u
      LEFT JOIN college c ON c.college_id = u.college_id
      WHERE u.user_id = $1
      LIMIT 1
    `;
    const { rows } = await query(sql, [req.userId]);

    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json(rows[0]);
  } catch (e) {
    console.error('auth/me error', e);
    return res.status(500).json({ error: 'server error' });
  }
});


export default router;