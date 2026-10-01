import type { UploadDeclaration } from "../project-contract";

/** Reads one upload declaration from an untrusted JSON body. */
export function readUploadDeclaration(body: unknown): UploadDeclaration | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  if (
    !("filename" in body) ||
    !("mimeType" in body) ||
    !("byteSize" in body) ||
    !("sha256" in body)
  ) {
    return null;
  }
  const { filename, mimeType, byteSize, sha256 } = body;
  if (typeof filename !== "string" || typeof mimeType !== "string" || typeof sha256 !== "string") {
    return null;
  }
  if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize)) {
    return null;
  }
  return { filename, mimeType, byteSize, sha256 };
}
