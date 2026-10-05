/** Mirrors US-118's email and password limits; the API remains authoritative. */
export function credentialErrors(
  email: string,
  password: string,
): { email?: string; password?: string } {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.slice(normalized.indexOf("@") + 1);
  const validDomain = domain
    .split(".")
    .every((label) => /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  const errors: { email?: string; password?: string } = {};
  if (
    email.length > 254 ||
    !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized) ||
    !validDomain
  ) {
    errors.email = "Enter a valid email address (maximum 254 characters).";
  }
  if (password.length < 12 || password.length > 200)
    errors.password = "Use a password between 12 and 200 characters.";
  return errors;
}

/** Only existing application destinations can be used after authentication. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const decoded = decodeURIComponent(value);
    if (
      /[\s\\]/.test(decoded) ||
      [...decoded].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return "/";
    const url = new URL(value, "https://internal.invalid");
    if (url.origin !== "https://internal.invalid") return "/";
    if (
      url.pathname !== "/" &&
      !/^\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(
        url.pathname,
      )
    )
      return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
