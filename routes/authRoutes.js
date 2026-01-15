import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { query } from "../db.js";
import dotenv from "dotenv";
import { requireAuth } from "../middleware/auth.js";

dotenv.config();
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const FRONT_URL  = process.env.FRONT_URL;

const isProd = process.env.NODE_ENV === "production";

const cookieOpts = {
  httpOnly: true,
  secure: true,                 
  sameSite:"none",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000
};

// --- Configurar el transporte de correo ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

// =============== LOGIN =====================
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await query(`SELECT * FROM "user" WHERE email=$1`, [email]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

  const token = jwt.sign({ user_id: user.user_id }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("token", token, cookieOpts);
  res.json({ user_id: user.user_id, email: user.email, username: user.username });
});

// =============== REGISTRO ==================
router.post("/register", async (req, res) => {
  const { email, password, username, college, college_id, birthdate, gender } = req.body;

  const exists = await query(
    `SELECT 1 FROM "user" WHERE email=$1 OR username=$2 LIMIT 1`,
    [email, username]
  );
  if (exists.rows.length) {
    return res.status(409).json({ error: 'email o username ya registrados' });
  }

  const hash = await bcrypt.hash(password, 10);

  const result = await query(
    `INSERT INTO "user"(email,password,username,college,college_id,birthdate,gender)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING user_id,email,username, created_at`,
    [email, hash, username, college, college_id, birthdate, gender]
  );

  const token = jwt.sign({ user_id: result.rows[0].user_id }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("token", token, cookieOpts);
  res.json(result.rows[0]);
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

router.post('/logout', (_req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  });

  res.json({ ok: true });
});

// =============== RECUPERAR CONTRASEÑA ===============
router.post("/forgot", async (req, res) => {
  try {
    const { email } = req.body;
    const userRes = await query(`SELECT username FROM "user" WHERE email=$1`, [email]);
    if (!userRes.rows.length) return res.status(404).json({ error: "Usuario no encontrado" });

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "15m" });
    const link = `${FRONT_URL}/pages/reset.html?token=${token}`;

    await transporter.sendMail({
      from: `"VR App" <${process.env.MAIL_USER}>`,
      to: email,
      subject: "Recuperación de contraseña",
      html: `
        <p>Hola ${userRes.rows[0].username},</p>
        <p>Haz clic en el siguiente enlace para restablecer tu contraseña (válido 15 min):</p>
        <a href="${link}">${link}</a>
      `,
    });

    res.json({ message: "Correo de recuperación enviado correctamente" });
  } catch (err) {
    console.error("Error en /forgot:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// =============== ACTUALIZAR CONTRASEÑA ===============
router.post("/reset/:token", async (req, res) => {
  try {
    const { newPassword } = req.body;
    const decoded = jwt.verify(req.params.token, JWT_SECRET);
    const email = decoded.email;

    const hash = await bcrypt.hash(newPassword, 10);
    await query(`UPDATE "user" SET password=$1 WHERE email=$2`, [hash, email]);
    res.json({ message: "Contraseña actualizada correctamente" });
  } catch (err) {
    console.error("Error en /reset:", err);
    res.status(400).json({ error: "Token inválido o expirado" });
  }
});

export default router;