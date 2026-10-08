// Send visitors on the old pages.dev address to the real domain, keeping the path (so shared /c/ links still work).
// Only active once the CANONICAL_HOST variable (e.g. fishr.monster) is set in Cloudflare, and never on preview deploys.
const OLD_HOST = "firetiger-fishing-log.pages.dev";

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (env.CANONICAL_HOST && url.hostname === OLD_HOST) {
    url.hostname = env.CANONICAL_HOST;
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
