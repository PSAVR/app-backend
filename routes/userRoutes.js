import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../db.js";
import dotenv from "dotenv";
import { requireAuth } from "../middleware/auth.js";

dotenv.config();
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET no está definido");
}



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

    if (targetId !== Number(req.userId)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    stage.v = "begin";
    await query("BEGIN");

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

    stage.v = "del-session";
    await query(
      `DELETE FROM session WHERE user_id = $1`,
      [targetId]
    );

    stage.v = "del-user-level-progress";
    await query(
      `DELETE FROM user_level_progress WHERE user_id = $1`,
      [targetId]
    );

    stage.v = "del-user";
    await query(
      `DELETE FROM "user" WHERE user_id = $1`,
      [targetId]
    );

    stage.v = "commit";
    await query("COMMIT");

    res.clearCookie?.("token", { path: "/", sameSite: "lax", secure: false });

    return res.status(204).send(); 
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

router.get('/:userId/history/level/:levelId', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const levelId = Number(req.params.levelId);
    const { start, end } = req.query;
    const tz = 'America/Lima';

    if (!userId || !levelId)
      return res.status(400).json({ error: 'userId y levelId requeridos' });

    const endDate = end || new Date().toISOString().slice(0, 10);
    const startDate =
      start ||
      new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);

    const sql = `
      SELECT
        (d.played_at AT TIME ZONE $5)::date AS day,
        d.progress_percentage,
        d.performance_summary,
        d.star_rating,
        d.emotion_result,
        d.pauses_count,
        d.played_at
      FROM session s
      JOIN session_detail d ON d.session_id = s.session_id
      WHERE s.user_id = $1
        AND s.level_id = $2
        AND (d.played_at AT TIME ZONE $5)::date >= $3::date
        AND (d.played_at AT TIME ZONE $5)::date <= $4::date
      ORDER BY day ASC
    `;

    const { rows } = await query(sql, [userId, levelId, startDate, endDate, tz]);
    res.json(rows);
  } catch (e) {
    console.error('user history by level error', e);
    res.status(500).json({ error: 'server error' });
  }
});

router.get('/:id/progress', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const sql = `
      SELECT
        l.level_id,
        l.name AS level_name,
        l.difficulty_order,
        COALESCE(ulp.attempts, 0)      AS attempts,
        COALESCE(ulp.max_stars, 0)     AS max_stars,
        COALESCE(ulp.max_progress, 0)  AS max_progress,
        ulp.passed,
        ulp.date                       AS last_update
      FROM level l
      LEFT JOIN user_level_progress ulp
             ON ulp.level_id = l.level_id
            AND ulp.user_id  = $1
      ORDER BY l.difficulty_order ASC;
    `;

    const { rows } = await query(sql, [userId]);

    const out = rows.map(r => {
      const ms = Math.max(0, Math.min(3, Number(r.max_stars || 0)));
      const panel_progress = Math.round((ms / 3) * 100);
      return {
        level_id: r.level_id,
        name: r.name,
        difficulty_order: r.difficulty_order,
        attempts: Number(r.attempts || 0),
        max_stars: ms,
        max_progress: Number(r.max_progress || 0), 
        passed: !!r.passed,
        panel_progress,
        last_update: r.last_update || null,
      };
    });

    res.json(out);
  } catch (e) {
    console.error('progress error', e);
    res.status(500).json({ error: 'no se pudo obtener el progreso' });
  }
});

export default router;
