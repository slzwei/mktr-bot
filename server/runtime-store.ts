import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { InMemoryAuthStore, type AuthStore } from "./auth.js";
import { reconcileClipStorage } from "./clip-reconciliation.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { PrismaStore } from "./prisma-store.js";
import { InMemoryStore, type Store } from "./store.js";

const require = createRequire(import.meta.url);
export async function migrateDatabase(databaseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", path.resolve("prisma/schema.prisma")], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", (error) => reject(new Error("Could not launch prisma migrate deploy.", { cause: error })));
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`prisma migrate deploy failed (${signal ?? code}); API startup refused.`)));
  });
}

export async function initializeStore(env: NodeJS.ProcessEnv = process.env): Promise<{ store: Store; authStore: AuthStore }> {
  if (env.MKTR_STORE === "memory") {
    if (env.NODE_ENV === "production" || env.MKTR_TELEPHONY_MODE === "freeswitch") throw new Error("The memory store is only allowed for simulator development and tests.");
    logger.warn("Explicit simulator memory store selected; application records and sessions reset on restart.");
    return { store: new InMemoryStore(), authStore: new InMemoryAuthStore() };
  }
  if (env.MKTR_STORE && env.MKTR_STORE !== "prisma") throw new Error("MKTR_STORE must be prisma or memory.");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required. For disposable simulator development only, explicitly set MKTR_STORE=memory.");
  await migrateDatabase(env.DATABASE_URL);
  const store = await PrismaStore.connect(env.DATABASE_URL);
  try {
    await reconcileClipStorage(store, env.MKTR_CLIP_STORAGE_DIR ?? config.clipStorageDir);
    return { store, authStore: store };
  } catch (error) {
    await store.close();
    throw new Error("Clip storage reconciliation failed; API startup refused.", { cause: error });
  }
}
