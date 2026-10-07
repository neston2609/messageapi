import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** A JSON file store with serialized, atomic writes per process. */
export class JsonStore<T> {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly schema: z.ZodType<T>, private readonly initial: T) {}

  async read(): Promise<T> {
    await this.pending;
    try { return this.schema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.initial;
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    const validated = this.schema.parse(value);
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = join(dirname(this.path), `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.pending = operation.catch(() => undefined);
    await operation;
  }
}
