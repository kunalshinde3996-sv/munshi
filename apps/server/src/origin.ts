// Origin allowlist for the browser-facing API (CSRF / DNS-rebinding defence).
// Development: http://localhost:<any port> and http://127.0.0.1:<any port> (Vite may move ports).
// Production (NODE_ENV=production): only WEB_ORIGIN, the API's own origins and ALLOWED_ORIGINS.
// Everything else is rejected.
export interface OriginPolicy {
  isAllowed(origin: string): boolean;
  describe(): string;
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function makeOriginPolicy(opts: { webOrigin: string; port: number; allowedOrigins?: string; production?: boolean }): OriginPolicy {
  const exact = new Set(
    [opts.webOrigin, `http://localhost:${opts.port}`, `http://127.0.0.1:${opts.port}`, ...(opts.allowedOrigins ?? "").split(",")]
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
  const dev = !opts.production;
  return {
    isAllowed: (origin) => exact.has(origin) || (dev && LOOPBACK.test(origin)),
    describe: () => `${dev ? "http://localhost:<any port>, http://127.0.0.1:<any port>, " : ""}${[...exact].join(", ")}`,
  };
}
