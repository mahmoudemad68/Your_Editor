import assert from "node:assert/strict";
import { test } from "node:test";
import { createUuidV7, userId } from "@editagent/domain";
import { generateKeyPair, SignJWT } from "jose";
import { JwtSessionTokens } from "./jwt-session-tokens.js";

const SECRET = "local-development-jwt-secret-32chars";
const NOW = 1_700_000_000_000n;
const ACTOR = userId(createUuidV7(Number(NOW), Buffer.alloc(10, 1)));
const OTHER = userId(createUuidV7(Number(NOW), Buffer.alloc(10, 2)));

test("access tokens accept only an unexpired HS256 token for the issued subject", async () => {
  const tokens = new JwtSessionTokens(SECRET);
  const issued = await tokens.issueAccess(ACTOR, NOW);
  assert.equal(await tokens.verifyAccess(issued.token, NOW), ACTOR);

  const [header, payload, signature] = issued.token.split(".");
  assert.equal(header !== undefined && payload !== undefined && signature !== undefined, true);
  const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as {
    sub?: string;
  };
  claims.sub = OTHER;
  const changed = Buffer.from(JSON.stringify(claims)).toString("base64url");
  assert.equal(await tokens.verifyAccess(`${header}.${changed}.${signature}`, NOW), null);

  const last = signature?.slice(-1) === "A" ? "B" : "A";
  assert.equal(
    await tokens.verifyAccess(`${header}.${payload}.${signature?.slice(0, -1)}${last}`, NOW),
    null,
  );

  const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  assert.equal(await tokens.verifyAccess(`${noneHeader}.${payload}.`, NOW), null);

  const { privateKey } = await generateKeyPair("RS256");
  const issuedAt = Math.floor(Number(NOW) / 1000);
  const rsa = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(ACTOR)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 900)
    .sign(privateKey);
  assert.equal(await tokens.verifyAccess(rsa, NOW), null);
  assert.equal(await tokens.verifyAccess(issued.token, NOW + 16n * 60n * 1000n), null);
});
