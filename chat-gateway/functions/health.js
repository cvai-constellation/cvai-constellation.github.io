export function onRequestGet() {
  return Response.json({ ok: true, service: "cvai-chat-gateway" }, {
    headers: { "cache-control": "no-store" },
  });
}
