/** Baseline headers for an API that does not serve documents. */
export function securityHeaders(): (
  request: object,
  response: { setHeader(name: string, value: string): void },
  next: () => void,
) => void {
  return (_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    next();
  };
}
