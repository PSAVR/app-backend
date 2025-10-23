import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db.js";
import dotenv from "dotenv";
import { requireAuth } from "../middleware/auth.js";

dotenv.config();
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";


router.get("/me", requireAuth, async (req, res) => {
  try {
    const sql = `
      SELECT 
        u.user_id,
        u.username,
        u.email,
        u.gender,
        u.birthdate,
        u.created_at,
        COALESCE(u.college, c.college_name) AS college,
        u.current_level_id,
        l.name AS current_level_name
      FROM "user" u
      LEFT JOIN college c ON c.college_id = u.college_id
      LEFT JOIN level l ON l.level_id = u.current_level_id
      WHERE u.user_id = $1
      LIMIT 1
    `;
    const { rows } = await query(sql, [req.userId]);
    if (!rows.length) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error en /me:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});


router.delete("/:userId", requireAuth, async (req, res) => {
  const stage = { v: "start" };

  try {
    const targetId = Number(req.params.userId);
    if (!Number.isFinite(targetId)) {
      return res.status(400).json({ error: "userId inválido" });
    }

    // Solo permitir que cada uno se elimine a sí mismo
    if (targetId !== Number(req.userId)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    stage.v = "begin";
    await query("BEGIN");

    // 1️⃣ Eliminar detalles de sesiones del usuario
    stage.v = "del-session-detail";
    await query(
      `
      DELETE FROM session_detail
      WHERE session_id IN (
        SELECT session_id FROM session WHERE user_id = $1
      )
      `,
      [targetId]
    );

    // 2️⃣ Eliminar sesiones del usuario
    stage.v = "del-session";
    await query(
      `DELETE FROM session WHERE user_id = $1`,
      [targetId]
    );

    // 3️⃣ Eliminar progreso por nivel
    stage.v = "del-user-level-progress";
    await query(
      `DELETE FROM user_level_progress WHERE user_id = $1`,
      [targetId]
    );

    // 4️⃣ Eliminar usuario
    stage.v = "del-user";
    await query(
      `DELETE FROM "user" WHERE user_id = $1`,
      [targetId]
    );

    stage.v = "commit";
    await query("COMMIT");

    res.clearCookie?.("token", { path: "/", sameSite: "lax", secure: false });

    return res.status(204).send(); // No Content
  } catch (e) {
    console.error("delete user error @", stage.v, e);
    try {
      await query("ROLLBACK");
    } catch {}
    return res.status(500).json({ error: "server error", stage: stage.v });
  }
});

router.post("/me/assign-initial-level", requireAuth, async (req, res) => {
  try {
    const { anxiety_pct_max } = req.body || {};
    const val = Number(anxiety_pct_max);
    if (!Number.isFinite(val))
      return res.status(400).json({ error: "anxiety_pct_max inválido" });

    let levelName;
    if (val >= 66.7)      levelName = "Facil";
    else if (val >= 33.3) levelName = "Intermedio";
    else                  levelName = "Dificil";

    const r = await query(
      `SELECT level_id FROM level WHERE LOWER(name)=LOWER($1) LIMIT 1`,
      [levelName]
    );
    if (!r.rows.length)
      return res.status(500).json({ error: "No se encontró level_id para " + levelName });

    const levelId = r.rows[0].level_id;
    await query(
      `UPDATE "user" SET current_level_id = $1 WHERE user_id = $2`,
      [levelId, req.userId]
    );

    res.json({
      ok: true,
      assigned_level: { name: levelName, level_id: levelId },
      anxiety_pct_max: val
    });
  } catch (err) {
    console.error("❌ Error en assign-initial-level:", err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
