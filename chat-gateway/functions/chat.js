const SITE_ORIGIN = "https://cvai-constellation.github.io";

function originAllowed(origin) {
  if (origin === SITE_ORIGIN) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
}

export async function onRequestGet(context) {
  if (!originAllowed(context.request.headers.get("Origin"))) {
    return Response.json({ error: "Origin not allowed" }, { status: 403 });
  }
  const url = new URL(context.request.url);
  const room = url.searchParams.get("room") === "e2e" ? "e2e" : "global";
  return context.env.CHAT_ROOM.getByName(room).fetch(context.request);
}
