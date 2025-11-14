// Redis接続を既存のlibから再エクスポート
import { getRedisClient } from "@/lib/redis";

export const redis = getRedisClient();


