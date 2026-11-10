// Config resolution helpers, mirroring aux4/bot core's lib/config.js so a
// standalone command (send-template) that is NOT reached through the core's
// `aux4 bot <channel> <cmd>` dispatch can still resolve a bot's merged config
// from the same `bots`/`defaults` config.bot shape.

/**
 * aux4/config passes object/array values to commands as JSON strings.
 * This normalizes a value that may already be an object or a JSON string.
 */
export function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Expand ${ENV_VAR} references in a string against process.env. */
export function expandEnv(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => (env[name] !== undefined ? env[name] : ""));
}

/**
 * Resolve a single bot's merged config (defaults + per-bot overrides) by id,
 * without the channel-allowlist check the core's route handlers do (this is
 * used by send-template, a user-invoked utility, not a webhook route).
 */
export function resolveBotById(bots, defaults, botId, env = process.env) {
  const botMap = parseMaybeJson(bots, {}) || {};
  const defaultMap = parseMaybeJson(defaults, {}) || {};

  if (!botId || !Object.prototype.hasOwnProperty.call(botMap, botId)) {
    return null;
  }

  const bot = botMap[botId] || {};
  const merged = Object.assign({}, defaultMap, bot, { botId });
  for (const key of Object.keys(merged)) {
    merged[key] = expandEnv(merged[key], env);
  }
  return merged;
}
