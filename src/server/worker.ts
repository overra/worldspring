// Worker entry: static assets are served by the platform; /ws upgrades go to
// the single global GameRoom Durable Object.

export { GameRoom } from "./GameRoom";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const stub = env.GAME.getByName("main");
      return stub.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
