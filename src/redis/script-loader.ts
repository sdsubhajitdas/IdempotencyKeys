import type { RedisClient } from "bun";

/**
 * Loads a Lua script's source once and runs it via EVALSHA, which sends only
 * the script's hash instead of its full body on every call while Redis still
 * executes it atomically (single-threaded, start to finish, no other
 * command interleaves). The script is loaded into Redis's script cache
 * lazily on first use and reloaded automatically if the cache was flushed
 * (a NOSCRIPT reply) — e.g. after a Redis restart.
 */
export class LuaScript {
  private readonly sha: string;
  private loaded = false;

  constructor(private readonly source: string) {
    this.sha = new Bun.CryptoHasher("sha1").update(source).digest("hex");
  }

  async run(redis: RedisClient, keys: string[], args: Array<string | number>): Promise<unknown> {
    if (!this.loaded) {
      await redis.send("SCRIPT", ["LOAD", this.source]);
      this.loaded = true;
    }

    try {
      return await redis.send("EVALSHA", [this.sha, String(keys.length), ...keys, ...args.map(String)]);
    } catch (err) {
      if (err instanceof Error && err.message.includes("NOSCRIPT")) {
        this.loaded = false;
        return this.run(redis, keys, args);
      }
      throw err;
    }
  }
}
