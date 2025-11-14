// Redis接続を既存のlibから再エクスポート
import { redis as getRedisClient } from "@/lib/redis";

export const redis = getRedisClient();


