import type { Env } from "./relay-do.ts";

export { RelayDO } from "./relay-do.ts";

/**
 * Routes the API and agent streams to the single relay Durable Object, and serves the console
 * (static assets) for everything else. /join/<code> is one page that reads the code itself.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
      return env.RELAY.get(env.RELAY.idFromName("relay")).fetch(req);
    }
    if (url.pathname === "/" || url.pathname.startsWith("/join/")) {
      const page = url.pathname === "/" ? "/index.html" : "/join.html";
      return env.ASSETS.fetch(new Request(new URL(page, url), req));
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
