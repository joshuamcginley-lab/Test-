// Send visitors on the old pages.dev address (or www.) to the real domain, keeping the path (so shared /c/ links
// still work). One address also matters for passkeys, which only work on the domain they were made on.
// Only active once the CANONICAL_HOST variable (e.g. fishr.monster) is set in Cloudflare, and never on preview deploys.
// Every HTTPS answer also carries HSTS, so browsers only ever use https:// for fishr (about six months; subdomains
// aren't included, so nothing else on the domain is affected).
const OLD_HOST = "firetiger-fishing-log.pages.dev";
const HSTS = "max-age=15552000";

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url), host = env.CANONICAL_HOST;
  if (host && (url.hostname === OLD_HOST || url.hostname === "www." + host)) {
    url.hostname = host;
    return new Response(null, { status: 301, headers: { location: url.toString(), "strict-transport-security": HSTS } });
  }
  const res = await next();
  if (url.protocol !== "https:" || res.headers.has("strict-transport-security")) return res;
  const out = new Response(res.body, res); // responses from next() can be read-only
  out.headers.set("strict-transport-security", HSTS);
  return out;
}
