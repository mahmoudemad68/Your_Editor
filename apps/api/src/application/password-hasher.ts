/** Password hashing port. The argon2id adapter lives in infrastructure. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}
