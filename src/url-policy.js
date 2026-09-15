/**
 * Gateway / backend URL policy: only send credentials to expected hosts.
 *
 * Default: https + *.cursor.sh / *.cursor.com (and apex) / *.cursorvm.com, the
 * host family EnsureSandBox hands out for the box gateway (e.g.
 * <id>-pod-<id>.us12.cursorvm.com).
 * Local/dev: http(s)://127.0.0.1|localhost|::1 when GROK_BOT_ALLOW_LOCAL_GATEWAY=1.
 * Escape hatch: GROK_BOT_ALLOW_ANY_GATEWAY=1 (unsafe; disables host checks).
 */

function truthyEnv(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function allowAnyGateway() {
  return truthyEnv("GROK_BOT_ALLOW_ANY_GATEWAY");
}

export function allowLocalGateway() {
  return truthyEnv("GROK_BOT_ALLOW_LOCAL_GATEWAY");
}

function isLocalHostname(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

function isCursorHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  if (h === "cursor.sh" || h === "cursor.com") return true;
  return h.endsWith(".cursor.sh") || h.endsWith(".cursor.com") || h.endsWith(".cursorvm.com");
}

/**
 * @param {string} rawUrl
 * @param {{ kind?: "gateway" | "backend" }} [opts]
 * @returns {string} normalized URL without trailing slash
 */
export function assertAllowedCredentialUrl(rawUrl, opts = {}) {
  const kind = opts.kind || "gateway";
  const label = kind === "backend" ? "backend URL" : "gateway URL";
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error("Invalid " + label + ".");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Rejected " + label + ": userinfo is not allowed.");
  }

  const normalized = parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "")) + parsed.search;

  if (allowAnyGateway()) {
    return String(rawUrl).replace(/\/$/, "");
  }

  const host = parsed.hostname;
  const local = isLocalHostname(host);

  if (local) {
    if (!allowLocalGateway()) {
      throw new Error(
        "Rejected " +
          label +
          " host \"" +
          host +
          "\". Set GROK_BOT_ALLOW_LOCAL_GATEWAY=1 to permit localhost/127.0.0.1 gateways.",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Rejected " + label + ": local gateways must use http or https.");
    }
    return String(rawUrl).replace(/\/$/, "");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Rejected " + label + ": only https is allowed (got " + parsed.protocol + ").");
  }

  if (!isCursorHostname(host)) {
    throw new Error(
      "Rejected " +
        label +
        " host \"" +
        host +
        "\". Expected *.cursor.sh / *.cursor.com / *.cursorvm.com, or set GROK_BOT_ALLOW_LOCAL_GATEWAY=1 / GROK_BOT_ALLOW_ANY_GATEWAY=1.",
    );
  }

  // Prefer origin-only gateways; allow path if present but strip trailing slash consistently.
  void normalized;
  return String(rawUrl).replace(/\/$/, "");
}

/**
 * Redact common credential shapes from error / log strings.
 * Broader than a Bearer-only regex; avoids dumping tokens in stderr.
 */
export function redactSecrets(text) {
  let s = String(text);
  s = s.replace(/Bearer\s+[A-Za-z0-9._+\/=-]+/gi, "Bearer <redacted>");
  s = s.replace(
    /(["']?(?:authorization|gatewayToken|gateway_token|access_token|accessToken|refresh_token|refreshToken|token|x-anyrun-network-token)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
    "$1<redacted>",
  );
  s = s.replace(
    /(x-anyrun-network-token\s*[=:]\s*)(\S+)/gi,
    "$1<redacted>",
  );
  return s;
}
