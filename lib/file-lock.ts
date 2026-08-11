import { open, stat, unlink } from "node:fs/promises";

const STALE_LOCK_MS = 10 * 60 * 1000;

export async function withFileLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const lockStat = await stat(lockPath).catch(() => null);
    if (!lockStat || Date.now() - lockStat.mtimeMs <= STALE_LOCK_MS) {
      throw new Error("This operation is already running. No additional model call was made.");
    }
    await unlink(lockPath).catch(() => undefined);
    handle = await open(lockPath, "wx");
  }

  try {
    return await task();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}
