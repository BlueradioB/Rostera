import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, moduleDirectory.endsWith(`${sep}dist${sep}src`) ? "../.." : "..");
const defaultDatabase = resolve(projectRoot, "data", "rostera.sqlite");
const retentionCount = 7;

export async function createBackup(database: DatabaseSync, backupDirectory: string, retention = retentionCount, now = new Date()): Promise<string> {
  if (!Number.isInteger(retention) || retention < 1) throw new Error("Backup retention must be a positive whole number.");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const filename = join(backupDirectory, `rostera-${timestamp}.sqlite`);
  await backup(database, filename);
  chmodSync(filename, 0o600);
  const existing = readdirSync(backupDirectory)
    .filter((entry) => /^rostera-\d{4}-\d{2}-\d{2}T.*\.sqlite$/.test(entry))
    .sort()
    .reverse();
  for (const expired of existing.slice(retention)) unlinkSync(join(backupDirectory, expired));
  return filename;
}

async function backupFile(): Promise<void> {
  const databasePath = resolve(process.env.ROSTERA_DATABASE ?? defaultDatabase);
  if (!existsSync(databasePath)) throw new Error(`Database file not found: ${databasePath}`);
  const backupDirectory = resolve(process.env.ROSTERA_BACKUP_DIRECTORY ?? join(dirname(databasePath), "backups"));
  const database = new DatabaseSync(databasePath);
  try {
    console.log(`Created database backup: ${await createBackup(database, backupDirectory)}`);
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  backupFile().catch((error: unknown) => {
    console.error("Database backup failed:", error);
    process.exitCode = 1;
  });
}
