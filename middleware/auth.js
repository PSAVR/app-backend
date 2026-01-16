import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET no está definido");
}

export function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const token = bearer || req.cookies?.token;

    if (!token) return res.status(401).json({ error: "no token" });

    const dec = jwt.verify(token, JWT_SECRET);
    req.userId = dec.user_id || dec.uid;
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}

