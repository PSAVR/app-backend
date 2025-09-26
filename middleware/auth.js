import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

export function requireAuth(req, res, next) {
  try {
    const token =
      req.cookies?.token || (req.headers.authorization || "").replace(/^Bearer\s+/, "");
    if (!token) return res.status(401).json({ error: "no token" });
    const dec = jwt.verify(token, JWT_SECRET);
    req.userId = dec.user_id || dec.uid;
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}
