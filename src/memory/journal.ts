import { DatabaseSync } from "node:sqlite";

/** Digest-only mutation preimages let a restarted caller replay exact backend receipts. */
export class MemoryMutationJournal {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_tool_requests (
      namespace TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      revision TEXT NOT NULL, PRIMARY KEY(namespace, request_id)
    ) STRICT`);
  }

  close() {
    this.db.close();
  }

  /** No user text or receipt plaintext survives a memory fence in this journal. */
  get(namespace: string, requestId: string, fingerprint: string) {
    const row = this.db
      .prepare(
        "SELECT fingerprint, revision FROM memory_tool_requests WHERE namespace=? AND request_id=?",
      )
      .get(namespace, requestId);
    if (!row) return;
    if (row.fingerprint !== fingerprint)
      throw new Error("Memory retry conflicts with the original request");
    return String(row.revision);
  }

  freeze(
    namespace: string,
    requestId: string,
    fingerprint: string,
    revision: string,
  ) {
    this.db
      .prepare("INSERT OR IGNORE INTO memory_tool_requests VALUES (?,?,?,?)")
      .run(namespace, requestId, fingerprint, revision);
    return this.get(namespace, requestId, fingerprint) ?? revision;
  }
}
