// Thin wrapper around Meta's Graph API, shared by every Meta channel plugin
// (WhatsApp today; Messenger/Instagram later reuse this unchanged).
//
// The base URL and API version are overridable per-bot (`bot.apiUrl` /
// `bot.apiVersion`) or via environment variables (`WHATSAPP_API_URL` /
// `WHATSAPP_API_VERSION`) so tests can point at a local mock Graph API
// instead of https://graph.facebook.com.

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v27.0";

/** Build the versioned Graph API base, e.g. "https://graph.facebook.com/v27.0". */
export function apiBase(bot = {}) {
  const base = bot.apiUrl || process.env.WHATSAPP_API_URL || DEFAULT_BASE_URL;
  const version = bot.apiVersion || process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION;
  return `${String(base).replace(/\/+$/, "")}/${version}`;
}

/** POST a JSON body to a Graph API path, Bearer-authenticated with bot.token. */
export async function graphPost(bot, path, body) {
  const url = `${apiBase(bot)}/${String(path).replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bot.token || ""}`
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `Graph API ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** GET a Graph API path, Bearer-authenticated with bot.token. */
export async function graphGet(bot, path) {
  const url = `${apiBase(bot)}/${String(path).replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bot.token || ""}` }
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `Graph API ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** GET an arbitrary (possibly non-Graph, e.g. a CDN) URL, Bearer-authenticated, returning a Buffer. */
export async function fetchBinary(bot, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bot.token || ""}` }
  });
  if (!res.ok) {
    const err = new Error(`download failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
