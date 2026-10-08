// Send visitors on the old pages.dev address (or www.) to the real domain, keeping the path (so shared /c/ links
// still work). One address also matters for passkeys, which only work on the domain they were made on.
// Only active once the CANONICAL_HOST variable (e.g. fishr.monster) is set in Cloudflare, and never on preview deploys.
const OLD_HOST = "firetiger-fishing-log.pages.dev";

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url), host = env.CANONICAL_HOST;
  if (host && (url.hostname === OLD_HOST || url.hostname === "www." + host)) {
    url.hostname = host;
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
