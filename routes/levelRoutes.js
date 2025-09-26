import express from "express";
import { query } from "../db.js";

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const sql = `
      SELECT 
        level_id, 
        name, 
        difficulty_order
      FROM level
      ORDER BY difficulty_order ASC
    `;
    const { rows } = await query(sql);
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching levels:", err);
    res.status(500).json({ error: "Error fetching levels" });
  }
});


router.get("/by-name/:name", async (req, res) => {
  try {
    const name = (req.params.name || "").trim();
    if (!name) return res.status(400).json({ error: "name requerido" });

    const sql = `
      SELECT level_id, name, difficulty_order
      FROM level
      WHERE LOWER(name) = LOWER($1)
      LIMIT 1
    `;
    const { rows } = await query(sql, [name]);
    if (!rows.length) {
      return res.status(404).json({ error: "Nivel no encontrado" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error in /by-name:", err);
    res.status(500).json({ error: "server error" });
  }
});


router.get("/:id", async (req, res) => {
  try {
    const levelId = parseInt(req.params.id, 10);
    if (isNaN(levelId)) return res.status(400).json({ error: "id inválido" });

    const sql = `
      SELECT level_id, name, description, difficulty_order
      FROM level
      WHERE level_id = $1
      LIMIT 1
    `;
    const { rows } = await query(sql, [levelId]);
    if (!rows.length)
      return res.status(404).json({ error: "Nivel no encontrado" });

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error fetching level by id:", err);
    res.status(500).json({ error: "Error fetching level" });
  }
});

export default router;
