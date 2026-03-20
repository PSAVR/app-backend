import Redis from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  throw new Error("REDIS_URL no está definido");
}

const tlsOptions = REDIS_URL.startsWith("rediss://")
  ? { tls: { rejectUnauthorized: false } }
  : {};

export const redis = new Redis(REDIS_URL, {
  ...tlsOptions,
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on("error", (err) => {
  console.error("Redis error:", err);
});