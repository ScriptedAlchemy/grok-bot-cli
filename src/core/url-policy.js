/**
 * Gateway / backend URL policy: only send credentials to expected hosts.
 *
 * Gateway (box + API): https on *.cursor.sh / *.cursor.com (and apex) /
 * *.cursorvm.com (EnsureSandBox box hosts, e.g. <id>-pod-<id>.us12.cursorvm.com).
 * Backend (EnsureSandBox / Cursor API): https on *.cursor.sh / *.cursor.com only —
 * never *.cursorvm.com, so a CURSOR_ACCESS_TOKEN cannot be pointed at a box host.
 * Local/dev gateways: http(s)://127.0.0.1|localhost|::1 when GROK_BOT_ALLOW_LOCAL_GATEWAY=1.
 * Escape hatch: GROK_BOT_ALLOW_ANY_GATEWAY=1 (unsafe; disables host checks; warns once).
 * Test mode (GROK_BOT_TEST=1 or NODE_ENV=test): loopback only, for gateway and backend
 * alike, and the escape hatches are ignored — a test can never reach a live thread.
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

export function testMode() {
  return truthyEnv("GROK_BOT_TEST") || process.env.NODE_ENV === "test";
}

const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(message + "\n");
}

/** Test hook: clear the one-shot warn set. */
export function resetPolicyWarnings() {
  warned.clear();
}

function isLocalHostname(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function isCursorApiHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  if (h === "cursor.sh" || h === "cursor.com") return true;
  return h.endsWith(".cursor.sh") || h.endsWith(".cursor.com");
}

function isCursorGatewayHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return isCursorApiHostname(h) || h.endsWith(".cursorvm.com");
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

  if (testMode()) {
    if (!isLocalHostname(parsed.hostname) || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new Error(
        "Rejected " + label + " host \"" + parsed.hostname +
          "\": test mode (GROK_BOT_TEST / NODE_ENV=test) only allows http(s) loopback gateways.",
      );
    }
    return String(rawUrl).replace(/\/$/, "");
  }

  if (allowAnyGateway()) {
    warnOnce(
      "ALLOW_ANY",
      "warning: GROK_BOT_ALLOW_ANY_GATEWAY is set; credential host checks are disabled.",
    );
    return String(rawUrl).replace(/\/$/, "");
  }

  const host = parsed.hostname;
  const local = isLocalHostname(host);

  if (local) {
    if (kind === "backend") {
      throw new Error(
        "Rejected backend URL host \"" +
          host +
          "\". EnsureSandBox backends must be https on *.cursor.sh / *.cursor.com.",
      );
    }
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
    warnOnce(
      "ALLOW_LOCAL",
      "warning: GROK_BOT_ALLOW_LOCAL_GATEWAY is set; credentials may be sent to a loopback gateway.",
    );
    return String(rawUrl).replace(/\/$/, "");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Rejected " + label + ": only https is allowed (got " + parsed.protocol + ").");
  }

  const allowed =
    kind === "backend" ? isCursorApiHostname(host) : isCursorGatewayHostname(host);
  if (!allowed) {
    const expected =
      kind === "backend"
        ? "*.cursor.sh / *.cursor.com"
        : "*.cursor.sh / *.cursor.com / *.cursorvm.com";
    throw new Error(
      "Rejected " +
        label +
        " host \"" +
        host +
        "\". Expected " +
        expected +
        ", or set GROK_BOT_ALLOW_LOCAL_GATEWAY=1 / GROK_BOT_ALLOW_ANY_GATEWAY=1.",
    );
  }

  return String(rawUrl).replace(/\/$/, "");
}

/**
 * Redact common credential shapes from error / log strings.
 * Covers Bearer/Basic/scheme Authorization values, cookie headers, and named token fields.
 */
export function redactSecrets(text) {
  let s = String(text);
  // Cookie headers first so a later Authorization pass cannot swallow them.
  // Stop the value before the next header-shaped token on the same line.
  s = s.replace(
    /(^|[\s,{;])((?:set-cookie|cookie)\s*[:=]\s*)([^\n;]+?)(?=\s+(?:set-cookie|cookie|authorization|proxy-authorization)\b|\s*$)/gi,
    "$1$2<redacted>",
  );
  // Scheme + credential only (e.g. "Basic abc", "Bearer xyz") — not the rest of the line.
  s = s.replace(
    /(^|[\s,{;])((?:authorization|proxy-authorization)\s*[:=]\s*)(\S+(?:\s+\S+)?)/gi,
    "$1$2<redacted>",
  );
  s = s.replace(/Bearer\s+[A-Za-z0-9._+\/=-]+/gi, "Bearer <redacted>");
  s = s.replace(
    /(["']?(?:authorization|gatewayToken|gateway_token|access_token|accessToken|refresh_token|refreshToken|token|x-anyrun-network-token|cookie|set-cookie)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
    "$1<redacted>",
  );
  s = s.replace(/(x-anyrun-network-token\s*[=:]\s*)(\S+)/gi, "$1<redacted>");
  return s;
}
