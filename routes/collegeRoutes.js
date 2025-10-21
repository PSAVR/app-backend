import express from "express";
import { query } from "../db.js";

const router = express.Router();
router.get("/", async (_req, res) => {
  try {
    const sql = `
      SELECT
        college_id,
        college_name
      FROM college
      ORDER BY college_name ASC
    `;
    const result = await query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching colleges:", err);
    res.status(500).json({ error: "Error fetching colleges" });
  }
});

export default router;
