// The Content-Security-Policy serve.ts sends with every page. csp-build-guard checks the build
// against the same string (csp-guard.config.json), and test/csp-config.test.ts keeps the two equal.
// It lives in its own module so a test can import it without starting the server.
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
