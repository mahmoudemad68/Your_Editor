const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";

/** Inserts the accounts a membership foreign key requires. The hash is not a login secret. */
export async function seedUsers(pool, ids) {
  for (const id of ids) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, failed_login_count, created_at, updated_at)
       VALUES ($1, $2, $3, 0, 10, 10)
       ON CONFLICT (id) DO NOTHING`,
      [String(id), `${String(id)}@example.test`, PASSWORD_HASH],
    );
  }
}
