/** Migrations run synchronously before the object serves requests. */
export function migrate(storage: DurableObjectStorage, clinicId: string): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL, clinic_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, delivered_revision INTEGER NOT NULL DEFAULT 0
    )`);
    const existing = sql.exec('SELECT * FROM metadata').toArray()[0];
    if (
      existing &&
      (existing.clinic_id !== clinicId || existing.schema_version !== 1)
    )
      throw new Error('Incompatible clinic storage');
    sql.exec(
      'INSERT OR IGNORE INTO metadata(singleton, schema_version, clinic_id) VALUES (1, 1, ?)',
      clinicId,
    );
    // Table names are static; all record values use parameter binding.
    for (const table of [
      'clinic_settings',
      'working_hours',
      'blocked_slots',
      'patients',
      'activity_log',
    ])
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)))`,
      );
    sql.exec(`CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)),
      date TEXT GENERATED ALWAYS AS (json_extract(record, '$.appointmentDate')) STORED,
      start TEXT GENERATED ALWAYS AS (json_extract(record, '$.startTime')) STORED,
      end TEXT GENERATED ALWAYS AS (json_extract(record, '$.endTime')) STORED,
      status TEXT GENERATED ALWAYS AS (json_extract(record, '$.status')) STORED
    )`);
    sql.exec(
      'CREATE INDEX IF NOT EXISTS appointments_date ON appointments(date, start, id)',
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS projection_outbox (
      revision INTEGER PRIMARY KEY, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
      last_error TEXT
    )`);
  });
}
