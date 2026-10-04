import argon2 from "argon2";
import { type PasswordHasher } from "../application/password-hasher.js";

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Argon2id password hasher. The encoding starts with `$argon2id$`. */
export class Argon2idHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
