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
    // Additive delivery migration, separate from the unchanged domain/schema-v1 records.
    sql.exec(`CREATE TABLE IF NOT EXISTS projection_delivery (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_error_at INTEGER
    )`);
    const delivery = sql
      .exec('SELECT version FROM projection_delivery WHERE singleton=1')
      .toArray()[0];
    if (delivery && delivery.version !== 1)
      throw new Error('Incompatible delivery storage');
    if (!delivery) {
      sql.exec('ALTER TABLE projection_outbox ADD COLUMN created_at INTEGER');
      sql.exec(`UPDATE projection_outbox SET created_at=COALESCE(
        (SELECT MAX(unixepoch(json_extract(value, '$.cells[4]')) * 1000) FROM json_each(snapshot, '$.sheets.Activity_Log')),
        next_attempt_at)`);
      sql.exec(
        "UPDATE projection_outbox SET last_error=json_object('category','Transient','message','Projection service is temporarily unavailable','automaticRetry',json('true')) WHERE last_error IS NOT NULL",
      );
      sql.exec(`INSERT INTO projection_delivery(singleton,version,failed_attempts)
        SELECT 1,1,COALESCE(SUM(attempts),0) FROM projection_outbox`);
      sql.exec(
        `UPDATE projection_delivery SET last_error=(SELECT last_error FROM projection_outbox WHERE last_error IS NOT NULL ORDER BY revision DESC LIMIT 1)`,
      );
    }
  });
}
