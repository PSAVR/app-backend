import express from "express";
import multer from "multer";
import fss from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import FormData from "form-data";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

ffmpeg.setFfmpegPath(ffmpegPath);
const router = express.Router();

const upload = multer({ 
  dest: os.tmpdir() 
});

const MODEL_API_URL = process.env.MODEL_API_URL || "http://localhost:8080";
const TZ = "America/Lima";

const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || (10 * 60 * 1000));
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);

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
    if (a <= 33.3) return 3;
    if (a <= 55.5) return 2;
    return 1;
  }
  // fácil
  if (a <= 66.6) return 3;
  if (a <= 83.3) return 2;
  return 1;
}

function decideNextLevel(immersionLevelId, starRating, anxietyPct, currentLevelDb) {
  const levelId = Number(immersionLevelId);
  const currentLevel = Number(currentLevelDb || 1);
  
  console.log('🎯 decideNextLevel INPUT:', {
    immersionLevelId: levelId,
    starRating,
    anxietyPct: anxietyPct.toFixed(2) + '%',
    currentLevelDb: currentLevel
  });

  if (anxietyPct < 33) {
    console.log('✅ Ansiedad < 33% (' + anxietyPct.toFixed(2) + '%) → Saltar a nivel 3');
    return 3;
  }

  if (starRating === 3) {
    let nextLevel = levelId;
    
    if (levelId === 1) {
      nextLevel = 2;
      console.log('3 estrellas en nivel 1 (ansiedad: ' + anxietyPct.toFixed(2) + '%) → Avanzar a nivel 2');
    } else if (levelId === 2) {
      nextLevel = 3;
      console.log('3 estrellas en nivel 2 (ansiedad: ' + anxietyPct.toFixed(2) + '%) → Avanzar a nivel 3');
    } else if (levelId === 3) {
      nextLevel = 3;
      console.log('3 estrellas en nivel 3 → Mantener nivel 3');
    } else {
      console.warn('Nivel desconocido:', levelId, '→ Mantener nivel 3');
      nextLevel = 3;
    }
    
    const finalLevel = Math.max(nextLevel, currentLevel);
    console.log('Verificación anti-retroceso: nextLevel=' + nextLevel + ', currentLevel=' + currentLevel + ' → finalLevel=' + finalLevel);
    return finalLevel;
  }

  const maintainedLevel = Math.max(levelId, currentLevel);
  console.log('Menos de 3 estrellas (ansiedad: ' + anxietyPct.toFixed(2) + '%) → Mantener nivel', maintainedLevel);
  return maintainedLevel;
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

async function cleanupTempFiles(...files) {
  for (const file of files) {
    if (file) {
      try {
        await fs.unlink(file);
      } catch (err) {

      }
    }
  }
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
  let tempFiles = []; 
  
  try {
    const user_id = Number(req.body.user_id || req.userId);
    let immersion_level_id = req.body.immersion_level_id ? Number(req.body.immersion_level_id) : null;
    let immersion_level_name = (req.body.immersion_level_name || "").trim();

    if (!user_id || !req.file)
      return res.status(400).json({ error: "user_id y audio son requeridos" });

    tempFiles.push(req.file.path);

    if (!immersion_level_id && immersion_level_name) {
      const r = await query(
        `SELECT level_id, name FROM level WHERE LOWER(name)=LOWER($1) LIMIT 1`,
        [immersion_level_name]
      );
      if (!r.rows.length) {
        await cleanupTempFiles(...tempFiles);
        return res.status(422).json({ error: "Nivel de inmersión no válido" });
      }
      immersion_level_id = r.rows[0].level_id;
      immersion_level_name = r.rows[0].name;
    }

    // Convertir a WAV
    stage.v = "ffmpeg";
    const inFile = req.file.path;
    const wavFile = path.join(os.tmpdir(), `${path.basename(inFile)}.wav`);
    tempFiles.push(wavFile);

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
    stage.v = "model-enqueue";
    const fd = new FormData();
    fd.append("file", fss.createReadStream(wavFile), {
      filename: "audio.wav",
      contentType: "audio/wav",
    });
    fd.append("user_id", String(user_id));

    const enqueue = await fetch(`${MODEL_API_URL}/anxiety_async`, { 
      method: "POST", 
      body: fd, 
      headers: fd.getHeaders() 
    });
    
    if (!enqueue.ok) {
      await cleanupTempFiles(...tempFiles);
      throw new Error(`Modelo enqueue fallo: ${enqueue.status}`);
    }
    const { task_id } = await enqueue.json();
    if (!task_id) {
      await cleanupTempFiles(...tempFiles);
      throw new Error("Modelo: no entregó task_id");
    }

    stage.v = "model-poll";
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
      if (Date.now() - t0 > POLL_TIMEOUT_MS) {

        await cleanupTempFiles(...tempFiles);
        throw new Error("Timeout esperando resultado del modelo");
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!Number.isFinite(anxiety_pct)) {
      await cleanupTempFiles(...tempFiles);
      throw new Error("Modelo sin anxiety_pct");
    }

    stage.v = "scoring";
    const band = bandFromAnxiety(anxiety_pct);
    const stars = starsFromAnxietyByImmersion(immersion_level_name, anxiety_pct);
    const progress = Math.round((stars / 3) * 100);

    stage.v = "db-transaction";
    await query("BEGIN");
    
    const todayKey = limaDateKey(new Date());
    await query("SELECT pg_advisory_xact_lock($1,$2)", [
      user_id,
      lockKey2(immersion_level_id, todayKey),
    ]);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const existingSessionResult = await query(
      `SELECT s.session_id, sd.star_rating, sd.progress_percentage
       FROM session s
       INNER JOIN session_detail sd ON s.session_id = sd.session_id
       WHERE s.user_id = $1 
         AND s.level_id = $2
         AND sd.played_at >= $3::timestamp AT TIME ZONE 'America/Lima'
         AND sd.played_at < $4::timestamp AT TIME ZONE 'America/Lima'
       ORDER BY sd.star_rating DESC, sd.progress_percentage DESC
       LIMIT 1`,
      [user_id, immersion_level_id, todayStart.toISOString(), todayEnd.toISOString()]
    );

    let session_id;
    let shouldCreateNew = true;

    if (existingSessionResult.rows.length > 0) {
      const existing = existingSessionResult.rows[0];
      const existingStars = Number(existing.star_rating) || 0;
      const existingProgress = Number(existing.progress_percentage) || 0;

      console.log('Sesión existente hoy:', {
        session_id: existing.session_id,
        existingStars,
        existingProgress,
        newStars: stars,
        newProgress: progress
      });

      if (stars > existingStars || (stars === existingStars && progress > existingProgress)) {
        console.log('Nueva sesión - actualizando...');
        session_id = existing.session_id;
        shouldCreateNew = false;

        await query(
          `UPDATE session_detail
           SET emotion_result = $1,
               pauses_count = $2,
               performance_summary = $3,
               star_rating = $4,
               progress_percentage = $5,
               played_at = NOW()
           WHERE session_id = $6`,
          [
            band,
            pausesCount ?? 0,
            `anxiety=${anxiety_pct.toFixed(1)}% (nivel=${immersion_level_name})`,
            stars,
            progress,
            session_id
          ]
        );
      } else {
        console.log('Descartando sesion actual');
        session_id = existing.session_id;
        shouldCreateNew = false;
      }
    }

    if (shouldCreateNew) {
      console.log('Creando nueva sesión para hoy');
      const sres = await query(
        `INSERT INTO session (user_id, level_id)
         VALUES ($1,$2)
         RETURNING session_id`,
        [user_id, immersion_level_id]
      );
      session_id = sres.rows[0].session_id;

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
    }

    const progressCheck = await query(
      `SELECT max_stars, max_progress FROM user_level_progress 
       WHERE user_id = $1 AND level_id = $2`,
      [user_id, immersion_level_id]
    );
    
    let isNewBest = false;
    if (progressCheck.rows.length === 0) {
      isNewBest = true;
    } else {
      const currentMax = progressCheck.rows[0];
      const currentMaxStars = Number(currentMax.max_stars) || 0;
      const currentMaxProgress = Number(currentMax.max_progress) || 0;
      
      isNewBest = stars > currentMaxStars || 
                  (stars === currentMaxStars && progress > currentMaxProgress);
    }
    
    console.log('Progress:', {
      isNewBest,
      currentStars: stars,
      currentProgress: progress,
      historicMax: progressCheck.rows[0] || 'ninguno'
    });
    
    if (isNewBest) {
      await query(`
        INSERT INTO user_level_progress (
          user_id, level_id, attempts, max_stars, max_progress, passed, date
        )
        VALUES ($1, $2, 1, $3, $4, $5, NOW())
        ON CONFLICT (user_id, level_id)
        DO UPDATE SET
          attempts     = user_level_progress.attempts + 1,
          max_stars    = EXCLUDED.max_stars,
          max_progress = EXCLUDED.max_progress,
          passed       = user_level_progress.passed OR EXCLUDED.passed,
          date         = NOW()
      `, [
        user_id,
        immersion_level_id,
        stars,
        progress,
        stars === 3
      ]);
      console.log('Nuevo récord, fecha actualizada');
    } else {
      await query(`
        INSERT INTO user_level_progress (
          user_id, level_id, attempts, max_stars, max_progress, passed, date
        )
        VALUES ($1, $2, 1, $3, $4, $5, NOW())
        ON CONFLICT (user_id, level_id)
        DO UPDATE SET
          attempts = user_level_progress.attempts + 1
      `, [
        user_id,
        immersion_level_id,
        stars,
        progress,
        stars === 3
      ]);
      console.log('No es récord');
    }

    const ures = await query(
      `SELECT current_level_id FROM "user" WHERE user_id=$1 FOR UPDATE`, 
      [user_id]
    );
    
    const currentLevelDb = ures.rows[0]?.current_level_id ?? immersion_level_id;

    const nextLevel = decideNextLevel(immersion_level_id, stars, anxiety_pct, currentLevelDb);

    console.log('LEVEL DECISION:', {
      user_id,
      immersion_level_id,
      stars,
      anxiety_pct: anxiety_pct.toFixed(2),
      currentLevelDb,
      nextLevel,
      willUpdate: nextLevel !== currentLevelDb
    });
    
    if (nextLevel !== currentLevelDb) {
      const upd = await query(
        `UPDATE "user" SET current_level_id = $2 WHERE user_id = $1 RETURNING user_id, current_level_id`,
        [user_id, nextLevel]
      );
      
      console.log('LEVEL UPDATED:', {
        rowCount: upd.rowCount,
        newLevel: upd.rows[0]?.current_level_id,
        success: upd.rowCount > 0
      });

      if (upd.rowCount === 0) {
        console.error('UPDATE falló - no se actualizó ninguna fila');
      }
    } else {
      console.log('LEVEL UNCHANGED - no se requiere actualización');
    }

    await query("COMMIT");
    console.log('COMMIT exitoso');

    // Limpiar archivos temporales
    await cleanupTempFiles(...tempFiles);

    res.status(201).json({
      session_id,
      model: { anxiety_pct, band },
      detail: { 
        star_rating: stars, 
        progress_percentage: progress, 
        pauses_count: pausesCount ?? 0,
        level_updated: nextLevel !== currentLevelDb,
        new_level: nextLevel
      },
    });
  } catch (e) {
    console.error("audio-session error at stage:", stage.v, e);
    try {
      await query("ROLLBACK");
      console.log('ROLLBACK ejecutado');
    } catch (rollbackErr) {
      console.error('Error en ROLLBACK:', rollbackErr);
    }
    
    // Limpiar archivos en caso de error
    await cleanupTempFiles(...tempFiles);
    
    res.status(500).json({ 
      error: "Fallo en servidor", 
      stage: stage.v,
      message: String(e?.message || e) 
    });
  }
});

router.post('/eval/audio', upload.single('audio'), async (req, res) => {
  const stage = { v: 'start' };
  let tempFiles = [];
  
  try {
    const user_id  = Number(req.body.user_id || req.userId);
    let immersion_level_id   = req.body.immersion_level_id ? Number(req.body.immersion_level_id) : null;
    let immersion_level_name = (req.body.immersion_level_name || '').trim();

    if (!user_id || !req.file) {
      return res.status(400).json({ error: 'user_id y audio son requeridos' });
    }
    
    tempFiles.push(req.file.path);
    
    if (!immersion_level_id && !immersion_level_name) {
      immersion_level_id = req.body.level_id ? Number(req.body.level_id) : null;
    }
    if (!immersion_level_id && !immersion_level_name) {
      await cleanupTempFiles(...tempFiles);
      return res.status(400).json({ error: 'Nivel de inmersión requerido' });
    }

    stage.v = 'validate-level';
    if (immersion_level_name) {
      const r = await query(`SELECT level_id, name FROM level WHERE LOWER(name)=LOWER($1) LIMIT 1`, [immersion_level_name]);
      if (!r.rows.length) {
        await cleanupTempFiles(...tempFiles);
        return res.status(422).json({ error: 'Nivel de inmersión no válido (name)' });
      }
      immersion_level_id   = r.rows[0].level_id;
      immersion_level_name = r.rows[0].name;
    } else {
      const r = await query(`SELECT name FROM level WHERE level_id=$1`, [immersion_level_id]);
      if (!r.rows.length) {
        await cleanupTempFiles(...tempFiles);
        return res.status(422).json({ error: 'Nivel de inmersión no válido (id)' });
      }
      immersion_level_name = r.rows[0].name;
    }

    stage.v = 'ffmpeg';
    const inFile  = req.file.path;
    const wavFile = path.join(os.tmpdir(), `${path.basename(inFile)}.wav`);
    tempFiles.push(wavFile);
    
    await new Promise((resolve, reject) => {
      ffmpeg(inFile).audioChannels(1).audioFrequency(16000).toFormat('wav')
        .on('error', reject)
        .on('end', resolve)
        .save(wavFile);
    });

    stage.v = 'model-enqueue';
    const fd = new FormData();
    fd.append('file', fss.createReadStream(wavFile), {
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
      await cleanupTempFiles(...tempFiles);
      throw new Error(`Modelo enqueue fallo: ${enqueue.status} ${body.slice(0,200)}`);
    }
    const { task_id } = await enqueue.json();
    if (!task_id) {
      await cleanupTempFiles(...tempFiles);
      return res.status(502).json({ error: 'Modelo: no entregó task_id' });
    }

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
      if (Date.now() - t0 > POLL_TIMEOUT_MS) {
        await cleanupTempFiles(...tempFiles);
        throw new Error('Timeout esperando resultado del modelo');
      }
      await new Promise(rs => setTimeout(rs, 2000));
    }

    if (!Number.isFinite(anxiety_pct)) {
      await cleanupTempFiles(...tempFiles);
      console.warn('⚠️ No se detectó voz válida en el audio (eval)');
      return res.status(200).json({
        model: { anxiety_pct: null, band: null, immersion_level: immersion_level_name },
        detail: { 
          star_rating: 0, 
          progress_percentage: 0,
          no_voice_detected: true
        },
        error: 'No se detectó ninguna voz'
      });
    }

    stage.v = 'scoring';
    const band        = bandFromAnxiety(anxiety_pct);
    const star_rating = starsFromAnxietyByImmersion(immersion_level_name, anxiety_pct);
    const progress_internal = Math.max(0, Math.min(100, 100 - anxiety_pct));

    await cleanupTempFiles(...tempFiles);

    stage.v = 'respond';
    return res.status(200).json({
      model: { anxiety_pct, band, immersion_level: immersion_level_name },
      detail: { star_rating, progress_percentage: progress_internal }
    });
  } catch (e) {
    console.error('eval-audio error at stage:', stage.v, e);
    await cleanupTempFiles(...tempFiles);
    return res.status(500).json({ 
      error: 'Fallo en servidor', 
      stage: stage.v, 
      message: String(e?.message || e) 
    });
  }
});

export default router;