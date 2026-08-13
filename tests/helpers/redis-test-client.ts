import { RedisClient } from "bun";

export function createTestRedis(): RedisClient {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new RedisClient(url);
}

export function uniqueKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
