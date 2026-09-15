/** Called under the repository write lock. One DO alarm serves both durable queues. */
export async function scheduleClinicAlarm(
  storage: DurableObjectStorage,
  now: number,
): Promise<void> {
  const times: number[] = [];
  const projection = storage.sql
    .exec<{ next_attempt_at: number }>(
      'SELECT next_attempt_at FROM projection_outbox ORDER BY revision LIMIT 1',
    )
    .toArray()[0];
  if (projection) times.push(projection.next_attempt_at);
  for (const query of [
    'SELECT (SELECT next_attempt_at FROM wa_inbox WHERE payload IS NOT NULL ORDER BY sequence LIMIT 1) AS deadline',
    "SELECT MIN(next_attempt_at) AS deadline FROM wa_outbox o WHERE state IN ('pending','attempting') AND NOT EXISTS(SELECT 1 FROM wa_outbox earlier WHERE earlier.recipient=o.recipient AND earlier.state='pending' AND earlier.rowid<o.rowid)",
    'SELECT MIN(expires_at) AS deadline FROM wa_conversations',
    'SELECT MIN(expires_at) AS deadline FROM wa_status',
    "SELECT MIN(created_at+604800000) AS deadline FROM wa_outbox WHERE state NOT IN ('pending','attempting')",
  ]) {
    const deadline = storage.sql
      .exec<{ deadline: number | null }>(query)
      .one().deadline;
    if (deadline !== null) times.push(deadline);
  }
  if (times.length)
    await storage.setAlarm(Math.max(now + 1000, Math.min(...times)));
  else await storage.deleteAlarm();
}
