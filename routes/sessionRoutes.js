import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fss from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import FormData from "form-data";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

ffmpeg.setFfmpegPath(ffmpegPath);
const router = express.Router();
const upload = multer({ dest: "uploads/" });
const MODEL_API_URL = process.env.MODEL_API_URL || "http://localhost:8080";
const TZ = "America/Lima";

function normalizeLevelName(name) {
  const n = (name || "").toLowerCase();
  if (n.startsWith("fac")) return "facil";
  if (n.startsWith("int")) return "intermedio";
  if (n.startsWith("dif")) return "dificil";
  return "intermedio";
}

function bandFromAnxiety(a) {
  if (a < 33.3) return "baja";
  if (a <= 66.6) return "media";
  return "alta";
}

function starsFromAnxietyByImmersion(levelName, a) {
  const lvl = normalizeLevelName(levelName);
  if (lvl === "dificil") {
    if (a <= 11.1) return 3;
    if (a <= 22.2) return 2;
    return 1;
  }
  if (lvl === "intermedio") {
    if (a <= 44.4) return 3;
    if (a <= 55.5) return 2;
    return 1;
  }
  // fácil
  if (a <= 77.7) return 3;
  if (a <= 83.3) return 2;
  return 1;
}

function decideNextLevel(immersionLevelId, starRating, anxietyPct, currentLevelDb) {
  let next = currentLevelDb || immersionLevelId;

  if (anxietyPct < 33) {
    return 3;
  }

  if (starRating === 3) {
    if (immersionLevelId === 1) next = 2; 
    if (immersionLevelId === 2) next = 3; 
    if (immersionLevelId === 3) next = 3; 
  }

  return Math.max(next, currentLevelDb || immersionLevelId);
}


function limaDateKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("es-PE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = fmt.formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return Number(`${p.year}${p.month}${p.day}`);
}

function lockKey2(levelId, yyyymmdd) {
  return levelId * 100000000 + yyyymmdd;
}

router.post("/", requireAuth, async (req, res) => {
  const user_id = Number(req.body.user_id || req.userId);
  const level_id = Number(req.body.level_id);
  const d = req.body.detail || {};

  if (!user_id || !level_id)
    return res.status(400).json({ error: "user_id y level_id requeridos" });

  const emotion_result = d.emotion_result ?? null;
  const pauses_count = d.pauses_count ?? 0;
  const performance_summary = d.performance_summary ?? null;
  const star_rating = d.star_rating ?? 0;
  const progress_percentage = d.progress_percentage ?? 0;

  try {
    await query("BEGIN");

    const sres = await query(
      `INSERT INTO session (user_id, level_id)
       VALUES ($1,$2)
       RETURNING session_id`,
      [user_id, level_id]
    );
    const session_id = sres.rows[0].session_id;

    await query(
      `INSERT INTO session_detail
       (session_id, emotion_result, pauses_count, performance_summary,
        star_rating, progress_percentage, played_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      [session_id, emotion_result, pauses_count, performance_summary, star_rating, progress_percentage]
    );

    await query("COMMIT");
    res.status(201).json({ session_id });
  } catch (e) {
    await query("ROLLBACK");
    console.error("create session error", e);
    res.status(500).json({ error: "no se pudo crear la sesión" });
  }
});

router.post("/audio", requireAuth, upload.single("audio"), async (req, res) => {
  const stage = { v: "start" };
  try {
    const user_id = Number(req.body.user_id || req.userId);
    let immersion_level_id = req.body.immersion_level_id ? Number(req.body.immersion_level_id) : null;
    let immersion_level_name = (req.body.immersion_level_name || "").trim();

    if (!user_id || !req.file)
      return res.status(400).json({ error: "user_id y audio son requeridos" });

    if (!immersion_level_id && immersion_level_name) {
      const r = await query(
        `SELECT level_id, name FROM level WHERE LOWER(name)=LOWER($1) LIMIT 1`,
        [immersion_level_name]
      );
      if (!r.rows.length) return res.status(422).json({ error: "Nivel de inmersión no válido" });
      immersion_level_id = r.rows[0].level_id;
      immersion_level_name = r.rows[0].name;
    }

    // Convertir a WAV
    const inFile = req.file.path;
    const wavFile = `${inFile}.wav`;
    await new Promise((resolve, reject) => {
      ffmpeg(inFile)
        .audioChannels(1)
        .audioFrequency(16000)
        .toFormat("wav")
        .on("end", resolve)
        .on("error", reject)
        .save(wavFile);
    });

    // Enviar al modelo
    const wavBuf = await fs.readFile(wavFile);
    const fd = new FormData();
    fd.append("file", fss.createReadStream(wavFile), {
      filename: "audio.wav",
      contentType: "audio/wav",
    });
    fd.append("user_id", String(user_id));

    const enqueue = await fetch(`${MODEL_API_URL}/anxiety_async`, { method: "POST", body: fd, headers: fd.getHeaders(), });
    if (!enqueue.ok) throw new Error(`Modelo enqueue fallo: ${enqueue.status}`);
    const { task_id } = await enqueue.json();
    if (!task_id) throw new Error("Modelo: no entregó task_id");

    // Polling del resultado
    let anxiety_pct;
    let pausesCount = null;

    const t0 = Date.now();
    while (true) {
      const r = await fetch(`${MODEL_API_URL}/result/${encodeURIComponent(task_id)}`);
      if (r.ok) {
        const data = await r.json();
        if (data?.status === "done") {
          const payload = data.result || data;
          const model   = payload.model || payload;

          const rawAnxiety = model?.anxiety_pct ?? payload?.anxiety_pct;
          const rawPauses  = model?.pause_count ?? model?.pauses_count;

          if (rawAnxiety === null || typeof rawAnxiety === "undefined") {
            anxiety_pct = NaN;
          } else {
            anxiety_pct = Number(rawAnxiety);
          }

          if (rawPauses !== null && typeof rawPauses !== "undefined") {
            const n = Number(rawPauses);
            if (Number.isFinite(n) && n >= 0) {
              pausesCount = Math.round(n);
            }
          }

          break;
        }
      }
      if (Date.now() - t0 > 10 * 60 * 1000) throw new Error("Timeout esperando resultado del modelo");
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!Number.isFinite(anxiety_pct)) {
      throw new Error("Modelo sin anxiety_pct");
    }

    const band = bandFromAnxiety(anxiety_pct);
    const stars = starsFromAnxietyByImmersion(immersion_level_name, anxiety_pct);
    const progress = Math.round((stars / 3) * 100);


    await query("BEGIN");
    const todayKey = limaDateKey(new Date());
    await query("SELECT pg_advisory_xact_lock($1,$2)", [
      user_id,
      lockKey2(immersion_level_id, todayKey),
    ]);

    const sres = await query(
      `INSERT INTO session (user_id, level_id)
       VALUES ($1,$2)
       RETURNING session_id`,
      [user_id, immersion_level_id]
    );
    const session_id = sres.rows[0].session_id;

    await query(
      `INSERT INTO session_detail
         (session_id, emotion_result, pauses_count, performance_summary,
          star_rating, progress_percentage, played_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      [
        session_id,
        band,
        pausesCount ?? 0,
        `anxiety=${anxiety_pct.toFixed(1)}% (nivel=${immersion_level_name})`,
        stars,
        progress
      ]
    );

    await query(`
      INSERT INTO user_level_progress (
        user_id, level_id, attempts, max_stars, max_progress, passed, date
      )
      VALUES ($1, $2, 1, $3, $4, $5, NOW())
      ON CONFLICT (user_id, level_id)
      DO UPDATE SET
        attempts     = user_level_progress.attempts + 1,
        max_stars    = GREATEST(user_level_progress.max_stars, EXCLUDED.max_stars),
        max_progress = GREATEST(user_level_progress.max_progress, EXCLUDED.max_progress),
        passed       = user_level_progress.passed OR EXCLUDED.passed,
        date         = NOW()
      `, [
      user_id,
      immersion_level_id,
      stars,
      progress,
      stars == 3
    ]);


    const ures = await query(`SELECT current_level_id FROM "user" WHERE user_id=$1`, [user_id]);
    const currentLevelDb = ures.rows[0]?.current_level_id ?? immersion_level_id;

    const nextLevel = decideNextLevel(immersion_level_id, stars, anxiety_pct, currentLevelDb);

    await query(
      `UPDATE "user" SET current_level_id=$2 WHERE user_id=$1`,
      [user_id, nextLevel]
    );


    await query("COMMIT");
    await fs.unlink(req.file.path).catch(() => {});
    await fs.unlink(`${req.file.path}.wav`).catch(() => {});

    res.status(201).json({
      session_id,
      model: { anxiety_pct, band },
      detail: { star_rating: stars, progress_percentage: progress, pauses_count: pausesCount ?? 0},
    });
  } catch (e) {
    console.error("audio-session error at stage:", stage.v, e);
    try {
      await query("ROLLBACK");
    } catch {}
    res.status(500).json({ error: "Fallo en servidor", message: String(e?.message || e) });
  }
});


router.post('/eval/audio', upload.single('audio'), async (req, res) => {
  const stage = { v: 'start' };
  try {
    const user_id  = Number(req.body.user_id || req.userId);
    let immersion_level_id   = req.body.immersion_level_id ? Number(req.body.immersion_level_id) : null;
    let immersion_level_name = (req.body.immersion_level_name || '').trim();

    if (!user_id || !req.file) {
      return res.status(400).json({ error: 'user_id y audio son requeridos' });
    }
    if (!immersion_level_id && !immersion_level_name) {
      immersion_level_id = req.body.level_id ? Number(req.body.level_id) : null;
    }
    if (!immersion_level_id && !immersion_level_name) {
      return res.status(400).json({ error: 'Nivel de inmersión requerido' });
    }

    stage.v = 'validate-level';
    if (immersion_level_name) {
      const r = await query(`SELECT level_id, name FROM level WHERE LOWER(name)=LOWER($1) LIMIT 1`, [immersion_level_name]);
      if (!r.rows.length) return res.status(422).json({ error: 'Nivel de inmersión no válido (name)' });
      immersion_level_id   = r.rows[0].level_id;
      immersion_level_name = r.rows[0].name;
    } else {
      const r = await query(`SELECT name FROM level WHERE level_id=$1`, [immersion_level_id]);
      if (!r.rows.length) return res.status(422).json({ error: 'Nivel de inmersión no válido (id)' });
      immersion_level_name = r.rows[0].name;
    }

    stage.v = 'ffmpeg';
    const inFile  = req.file.path;
    const wavFile = `${inFile}.wav`;
    await new Promise((resolve, reject) => {
      ffmpeg(inFile).audioChannels(1).audioFrequency(16000).toFormat('wav')
        .on('error', reject)
        .on('end', resolve)
        .save(wavFile);
    });

    stage.v = 'model-enqueue';
    const wavBuf = await fs.readFile(wavFile);
    const fd = new FormData();
    fd.append('file',fss.createReadStream(wavFile), {
      filename: 'audio.wav',
      contentType: 'audio/wav',
    });
    fd.append('user_id', String(user_id));

    const enqueue = await fetch(`${MODEL_API_URL.replace(/\/$/, '')}/anxiety_async`, {
      method: 'POST',
      body: fd
    });
    if (!enqueue.ok) {
      const body = await enqueue.text().catch(() => '');
      throw new Error(`Modelo enqueue fallo: ${enqueue.status} ${body.slice(0,200)}`);
    }
    const { task_id } = await enqueue.json();
    if (!task_id) return res.status(502).json({ error: 'Modelo: no entregó task_id' });

    stage.v = 'model-poll';
    let anxiety_pct;
    const t0 = Date.now();
    while (true) {
      const r = await fetch(`${MODEL_API_URL}/result/${encodeURIComponent(task_id)}`, { method: 'GET' });
      if (r.ok) {
        const data = await r.json();
        if (data?.status === 'done') {
          const payload = data.result || data;
          const rawAnxiety = payload?.model?.anxiety_pct ?? payload?.anxiety_pct;

          if (rawAnxiety === null || typeof rawAnxiety === 'undefined') {
            anxiety_pct = NaN;
          } else {
            anxiety_pct = Number(rawAnxiety);
          }
          break;
        }
      }
      if ((Date.now() - t0) > 10 * 60 * 1000) {
        throw new Error('Timeout esperando resultado del modelo');
      }
      await new Promise(rs => setTimeout(rs, 2000));
    }

    if (!Number.isFinite(anxiety_pct)) {
      throw new Error('Modelo: respuesta sin anxiety_pct');
    }


    stage.v = 'scoring';
    const band        = bandFromAnxiety(anxiety_pct);
    const star_rating = starsFromAnxietyByImmersion(immersion_level_name, anxiety_pct);
    const progress_internal = Math.max(0, Math.min(100, 100 - anxiety_pct));

    stage.v = 'cleanup';
    await fs.unlink(req.file.path).catch(()=>{});
    await fs.unlink(`${req.file.path}.wav`).catch(()=>{});

    stage.v = 'respond';
    return res.status(200).json({
      model: { anxiety_pct, band, immersion_level: immersion_level_name },
      detail: { star_rating, progress_percentage: progress_internal }
    });
  } catch (e) {
    console.error('eval-audio error at stage:', stage.v, e);
    return res.status(500).json({ error: 'Fallo en servidor', stage: stage.v, message: String(e?.message || e) });
  }
});

export default router;
