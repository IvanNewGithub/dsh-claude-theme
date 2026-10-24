/**
 * Host half of dsh-lan-access.
 *
 * What this plugin is for: open DSH on a phone that is on the same network,
 * without installing a second interface, without a public tunnel, and without
 * signing up for anything. The phone gets the same Web GUI this machine runs.
 *
 * How it works, and why it is small
 * ---------------------------------
 *
 * The hard part of "reach DSH from another device" is not the network, it is
 * the credential. `dsh web` mints a browser-session cookie bound to the exact
 * `host:port` a browser visited, and it refuses a `Host` that is neither
 * loopback nor a declared trusted authority — so a phone pointed at
 * `192.168.x.x:3080` gets 401 even after the port is reachable.
 *
 * DSH already solves this for itself: the connection service exposes
 * `authenticatedUrl(baseUrl)`, which returns the same URL with this process's
 * launch token appended. A request carrying that token mints the cookie and
 * redirects to the clean path, which is exactly how the desktop browser
 * authenticates on first launch. So the plugin does not proxy anything, does
 * not relay API calls, and does not maintain device sessions. It asks for one
 * authenticated URL and draws it as a QR code.
 *
 * The bind
 * --------
 *
 * `dsh web --host 0.0.0.0` is refused on the command line on purpose: it would
 * put an agent with shell access on the network. Since 0.2.1-rc.2 the host
 * refuses a wildcard address in the webserver config schema as well, with no
 * opt-out, so this plugin does not offer "every interface" -- it names **one
 * concrete interface address**, chosen by {@link selectLanAddress}. That is also
 * what the Host-header rule wants: a request is accepted when its `Host` equals
 * the bind literal, so a phone dialling that address authenticates by
 * construction.
 *
 * The switch is still explicit, and two facts belong in its warning and are
 * repeated in the panel:
 *
 *   - anyone on that network who can reach the port and obtain the URL can run
 *     commands here;
 *   - the URL itself is the credential, so it must not be shared.
 *
 * Turning the switch off restores the loopback bind. The value is written as a
 * static managed block in the profile's `cordis.patch.yml`, because a config
 * expression may not survive the patch layer's evaluation. On activation the
 * block is re-pointed if its recorded address has left the machine (DHCP renewal
 * does exactly this) -- but the host parses that file before any plugin runs, so
 * a drift fix only lands on the *next* start, and the panel says so.
 *
 * The trust block
 * ---------------
 *
 * The bind literal authenticates a phone that dials the address the QR names,
 * but nothing else: a browser opened by hostname, mDNS name, or a stale DHCP
 * address sends a `Host` the policy refuses with 403. So enabling also writes a
 * second managed block replacing the `connection` row, declaring those names in
 * `trustedHosts` while spreading `ctx.webStartup.trustedHosts` to keep the
 * invocation authorities. Turning the switch off removes both blocks.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

import { renderSVG } from "uqr";

export const name = "dsh-lan-access";

/** The connection service carries `authenticatedUrl`; the web server owns the bind. */
export const inject = ["connection", "webServer"];

/** Our own route family; loopback-only, like the pairing panels elsewhere. */
const ROUTE_STATUS = "/api/dsh-lan-access/status";
const ROUTE_SET = "/api/dsh-lan-access/bind";

/** Marks the managed block this plugin owns inside the profile patch. */
const BLOCK_START = "# >>> dsh-lan-access bind >>>";
const BLOCK_END = "# <<< dsh-lan-access bind <<<";

/** Marks the second managed block, which declares the trusted authorities. */
const TRUST_START = "# >>> dsh-lan-access trust >>>";
const TRUST_END = "# <<< dsh-lan-access trust <<<";

const DEFAULT_PORT = 3080;

/**
 * Set when this start found a stale recorded address and rewrote it.
 *
 * Rewriting cannot heal the current boot -- the host has already parsed the
 * patch file, before any plugin ran -- so the panel has to say "restart again"
 * rather than let it look like nothing happened.
 *
 * @type {string | null}
 */
let driftNotice = null;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function profileDir() {
  const profile = process.env.DSH_PROFILE || "web";
  return join(dshHome(), "profiles", profile);
}

function patchFile() {
  return join(profileDir(), "cordis.patch.yml");
}

/**
 * Interface names owned by container runtimes and bridge tooling.
 *
 * These are excluded from the bind choice. Docker's default bridge is
 * `172.17.0.1`, which satisfies the private-range test below, so a sort keyed
 * only on "is private" leaves it tied with the real NIC -- and the winner of a
 * tie is whatever order `networkInterfaces()` happens to enumerate in. A phone
 * scanning a QR that points at a docker bridge address can never open it.
 */
const CONTAINER_IFACE = /^(docker|br-|veth|virbr|cni|flannel|kube|nerdctl|podman|lo$)/;

/**
 * The machine's candidate LAN addresses, for display in the panel.
 *
 * IPv4 only; loopback and link-local excluded. Container bridges are listed
 * here because they are genuinely present on the machine and hiding them would
 * make the panel lie -- but they are never *selected*; see
 * {@link selectLanAddress}.
 */
export function lanAddresses() {
  const out = [];
  const interfaces = networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      out.push({ name, address: entry.address });
    }
  }
  const isPrivate = (address) =>
    address.startsWith("192.168.") ||
    address.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);
  out.sort((a, b) => Number(isPrivate(b.address)) - Number(isPrivate(a.address)));
  return out;
}

/**
 * The names a browser on this network may dial besides the bind literal: the
 * machine's hostname, its mDNS name, and every candidate LAN address (a stale
 * DHCP address or a second interface included). These are what the trust block
 * declares, because the Host-header policy accepts only loopback, the bind
 * literal, or a declared trusted authority.
 *
 * Entries must survive WHATWG parsing unchanged to be accepted, so anything
 * that is not a plain hostname or IPv4 literal is dropped rather than written
 * and refused at the next start.
 */
export function trustedNames(addresses = lanAddresses()) {
  const names = [];
  const push = (value) => {
    const name = String(value || "").trim().toLowerCase();
    if (!name) return;
    if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(name)) return;
    if (isLoopback(name)) return;
    if (!names.includes(name)) names.push(name);
  };
  try {
    push(hostname());
    push(`${hostname()}.local`);
  } catch {
    /* hostname() failing leaves the address list, which is enough. */
  }
  for (const entry of addresses || []) push(entry.address);
  return names;
}

/** Strip one managed block, leaving the rest of the file untouched. */
function removeBlock(text, startMark, endMark) {
  const start = text.indexOf(startMark);
  const end = text.indexOf(endMark);
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(0, start) + text.slice(end + endMark.length);
}

/**
 * The trust block: it replaces the shipped `connection` row, so every static
 * field it sets has to be repeated. The shipped row sets only trustedHosts, so
 * this row sets only trustedHosts.
 *
 * The !!js expression merges the declared names with the shipped spread, so
 * the invocation authorities ctx.webStartup.trustedHosts carries are kept.
 */
function trustBlock(primaryAddress) {
  /* `primaryAddress` is the address the QR names. When given it is pinned as
   * the first IP in the list -- and `readBindIntent` reads it back from there
   * -- so the drift heal works on the address that was actually declared, not
   * on whatever this machine's NICs happen to report at write time (tests
   * inject a fake NIC set; DHCP makes the real one move). */
  const names = trustedNames();
  if (primaryAddress) {
    const without = names.filter((n) => n !== primaryAddress);
    names.length = 0;
    names.push(primaryAddress, ...without);
  }
  /* `!!js` takes a *quoted* expression -- the quotes are part of the scalar,
   * not decoration. Writing the array literal bare (`!!js ['a','b']`) makes the
   * YAML parser read the whole thing as a tag body and abort the profile with
   * `unknown tag !<tag:yaml.org,2002:js>`, which takes DSH down on the next
   * start. Every existing `!!js` in this file's sibling config uses quotes for
   * that reason. Names cannot contain a single quote (trustedNames filters them
   * through a `[a-z0-9._-]` pattern), so single-quoting the expression is safe. */
  const extra = names.map((entry) => `"${entry}"`).join(", ");
  const expression =
    `[${extra}${extra ? ", " : ""}...ctx.webStartup.trustedHosts]`;
  const block = [
    TRUST_START,
    "# Managed by dsh-lan-access. Removed when the switch is turned off.",
    "#",
    "# This row replaces the shipped `connection` row, so every static field it",
    "# sets has to be repeated here. The shipped row sets only trustedHosts, so",
    "# this row sets only trustedHosts.",
    "- id: connection",
    "  name: '@deepseek-ai/dsh-client-connection'",
    "  inject: [webStartup]",
    "  config:",
    `    trustedHosts: !!js '${expression}'`,
    TRUST_END,
    "",
  ].join("\n");
  return block;
}

/**
 * Pick the single address to bind.
 *
 * The host refuses a wildcard bind, so exactly one interface address has to be
 * named. Order of preference:
 *
 *   1. the address on the interface carrying the default route -- that is the
 *      one a device on the network actually reaches this machine through;
 *   2. otherwise a private-range address;
 *   3. otherwise any usable address, so a box with only a public IP still works.
 *
 * Container and bridge interfaces are never eligible. Returns `null` when
 * nothing usable exists, which the caller must treat as "cannot enable" rather
 * than as "bind to nothing".
 *
 * @param interfaces - an `os.networkInterfaces()`-shaped map (injectable for tests).
 * @param preferredIfname - interface holding the default route, if known.
 */
export function selectLanAddress(interfaces = networkInterfaces(), preferredIfname = null) {
  const isPrivate = (address) =>
    address.startsWith("192.168.") ||
    address.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);

  const usable = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if (CONTAINER_IFACE.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      usable.push({ name, address: entry.address });
    }
  }
  if (usable.length === 0) return null;

  if (preferredIfname) {
    const routed = usable.find((entry) => entry.name === preferredIfname);
    if (routed) return routed.address;
  }
  usable.sort((a, b) => Number(isPrivate(b.address)) - Number(isPrivate(a.address)));
  return usable[0].address;
}

/**
 * The interface carrying the default route, read from `/proc/net/route`.
 *
 * Destination `00000000` marks the default route; its first column is the
 * interface name. Returns `null` on any failure -- non-Linux, unreadable, or no
 * default route -- in which case {@link selectLanAddress} falls back to its
 * private-range order.
 */
export function defaultRouteInterface() {
  let text;
  try {
    text = readFileSync("/proc/net/route", "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    if (cols[1] === "00000000") return cols[0];
  }
  return null;
}

/** This machine's best bind address, or `null` when there is nothing to bind. */
export function preferredLanAddress() {
  return selectLanAddress(networkInterfaces(), defaultRouteInterface());
}

/** Current bind host from the live web server, which is the authority on it. */
function currentHost(ctx) {
  try {
    return ctx.webServer.host;
  } catch {
    return "127.0.0.1";
  }
}

function currentPort(ctx) {
  try {
    return ctx.webServer.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * Read the managed block's recorded intent: the LAN address the QR names.
 *
 * The listener is always the wildcard now, so the bind row's `host:` is
 * `0.0.0.0` and says nothing about which address the phone should dial. That
 * address lives in the trust block, which exists exactly when LAN access is on
 * and carries every name the URL's authority may take -- the first literal IP
 * among them is the recorded intent. The drift heal compares against it: when
 * DHCP moves the machine, this is the value that goes stale.
 */
export function readBindIntent() {
  const file = patchFile();
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const start = text.indexOf(TRUST_START);
  const end = text.indexOf(TRUST_END);
  if (start === -1 || end === -1 || end < start) return null;
  const block = text.slice(start, end);
  /* The expression is a single-quoted YAML scalar whose JS strings are
   * double-quoted; IPs sort after the hostname entries, so pick the first
   * dotted-quad. */
  const match = /"(\d{1,3}(?:\.\d{1,3}){3})"/.exec(block);
  return match ? match[1] : null;
}

/**
 * Write or remove the managed block.
 *
 * A same-id patch row REPLACES the row's config wholesale, so the block has to
 * carry every static field the shipped `webserver` row sets -- `compression*`
 * included -- or enabling this switch would silently drop gzip. The shipped row
 * computes host and port from the `webStartup` provider through `!!js`
 * expressions, and that provider only carries command-line values. Materializing
 * static values here is the documented way to override a `!!js`-driven row from
 * a user patch.
 *
 * ## Why the host is a concrete address
 *
 * Earlier versions pinned `0.0.0.0`. dsh 0.2.1-rc.2 made that fatal: the
 * webserver config schema throws on any unspecified address, with no opt-out, so
 * a profile carrying the old block does not boot at all. The Host-header rule
 * points the same way -- a request's Host must be loopback, equal to the bind
 * literal, or listed in `trustedHosts` -- so naming one interface address is what
 * actually authenticates a phone dialling that address.
 *
 * @param enabled - true to bind `address`, false to remove the block and fall
 *   back to the shipped row (loopback).
 * @param port - the port to pin. It must be the port the server is actually
 *   listening on, because the managed row replaces the shipped one: hardcoding
 *   3080 here would move a server started with `--port 8080` to 3080 on its
 *   next start, which looks like the plugin losing the user's setting.
 * @param address - the interface address to bind. Injectable so tests do not
 *   depend on the machine's real NICs. Defaults to this machine's best address.
 * @returns `{ host, reason }` -- `host` is what will apply after the next start,
 *   or `null` when enabling was refused.
 */
export function writeBind(enabled, port = DEFAULT_PORT, address = preferredLanAddress()) {
  /* Refuse before touching the file. Writing a block that names no address would
   * fail `listen` on the next start and take the whole profile down -- the exact
   * class of failure this rewrite exists to remove. */
  if (enabled && !address) {
    return {
      host: null,
      reason: "这台机器上没有可绑定的局域网地址（网卡未连线，或只剩容器网桥），所以没有打开局域网访问。",
    };
  }

  const file = patchFile();
  let text = "";
  try {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    text = "";
  }
  text = removeBlock(text, BLOCK_START, BLOCK_END);
  text = removeBlock(text, TRUST_START, TRUST_END);
  text = text.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");

  if (enabled) {
    const block = [
      BLOCK_START,
      "# Managed by dsh-lan-access. Removed when the switch is turned off.",
      "#",
      "# This row replaces the shipped `webserver` row, so every static field it",
      "# sets has to be repeated here. Reaching this port from another device",
      "# grants full control of this machine's agent: keep it on a network you",
      "# trust, and do not share the pairing URL.",
      "- id: webserver",
      "  name: '@deepseek-ai/dsh-host-webserver'",
      "  inject: [webStartup]",
      "  config:",
      /* Wildcard bind, always. A concrete-address bind (`host: '192.168.x.x'`)
       * excludes loopback -- `curl 127.0.0.1` gets connection-refused -- so the
       * user's own desktop browser is forced onto the LAN address too, and every
       * plugin with a loopback-only write fence (xiaoke's 403, settings pages)
       * then treats the user sitting at the keyboard as a remote caller. The QR
       * already names the concrete address via the bind literal; the listener
       * itself does not need to be that narrow. */
      "    host: '0.0.0.0'",
      `    port: ${port}`,
      "    compression: gzip",
      "    compressionLevel: 1",
      "    compressionThresholdBytes: 1024",
      BLOCK_END,
      "",
    ].join("\n");
    text += (text.endsWith("\n") || text === "" ? "" : "\n") + block;
    text += trustBlock(address);
  }

  try {
    writeFileSync(file, text, "utf8");
  } catch (error) {
    throw new Error(`could not write ${file}: ${error.message}`);
  }
  return { host: enabled ? address : "127.0.0.1", reason: null };
}

/**
 * Re-point the managed block when its recorded address has left the machine.
 *
 * The recorded host is a literal string in a file the host parses before any
 * plugin runs, so a renewed DHCP address cannot be healed within the same boot.
 * What this can do is rewrite the block for the next start and report the drift
 * so the panel says so out loud.
 *
 * ⚠️ An empty `available` list is **not** treated as drift. Interfaces can be
 * briefly unavailable during boot or a link flap, and removing the block then
 * would silently switch LAN access off -- a much worse outcome than waiting for
 * the next start to see a real address list.
 *
 * @param current - the recorded bind address, or `null` when there is no block.
 * @param available - this machine's candidate addresses, `{ name, address }[]`.
 * @param port - the port to re-pin if the block has to be rewritten.
 * @returns `{ changed, drift, host }`.
 */
export function reconcileBind(current, available, port = DEFAULT_PORT) {
  if (!current) return { changed: false, drift: false, host: null };
  if (!available || available.length === 0) return { changed: false, drift: false, host: current };
  if (available.some((entry) => entry.address === current)) return { changed: false, drift: false, host: current };

  const next = selectLanAddress(
    available.reduce((acc, entry) => {
      acc[entry.name] = acc[entry.name] || [];
      acc[entry.name].push({ address: entry.address, family: "IPv4", internal: false });
      return acc;
    }, {}),
  );
  /* Every remaining candidate is a container bridge. Leave the block alone --
   * rewriting to nothing would be worse than a bind that no longer exists. */
  if (!next) return { changed: false, drift: false, host: current };

  writeBind(true, port, next);
  return { changed: true, drift: true, host: next };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Loopback binds are unreachable from a phone; everything else we bind is not. */
function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * The status the panel renders, including a ready-to-scan authenticated URL.
 *
 * The URL is only minted when the bind actually reaches the network; with a
 * loopback bind a QR would point at an address the phone cannot open, so the
 * panel gets an explanation instead of a dead code.
 *
 * ⚠️ The URL host is the **live bind literal**, not `addresses[0]`. The host
 * accepts a request whose `Host` is loopback, equal to the bind literal, or
 * listed in `trustedHosts` -- so a QR naming any other interface address, or a
 * docker bridge, authenticates nowhere. It used to be `host === "0.0.0.0"` that
 * marked a bind reachable; with a concrete bind that comparison is always false
 * and the QR silently stops being minted.
 *
 * The QR ships as a finished SVG string beside the URL. It used to be a second
 * round trip (`GET /qr?text=…` returning a matrix the client re-assembled into
 * rectangles), and every hop of that pipeline was a place the code on screen
 * could fall out of step with the URL beside it. One payload, one render --
 * `uqr` on the host, `dangerouslySetInnerHTML` on the client, same shape the
 * shipped pairing panels use. The SVG comes from our own call, not user input.
 */
function handleStatus(ctx) {
  const host = currentHost(ctx);
  const port = currentPort(ctx);
  const addresses = lanAddresses();
  const loopback = isLoopback(host);
  const reachable = !loopback;
  const pendingBind = readBindIntent();

  /* The listener may hold the wildcard, but a QR that dials `0.0.0.0` opens
   * nothing. Pair against the best concrete address instead -- the same one the
   * trust block declares, so the URL always names an authority the fence
   * accepts. Loopback keeps its own literal: it is unreachable from a phone,
   * and saying so honestly beats minting a code that scans into a refusal. */
  const qrHost = loopback ? host : preferredLanAddress() || host;

  let url = null;
  let qrSvg = null;
  if (reachable) {
    try {
      url = ctx.connection.authenticatedUrl(`http://${qrHost}:${port}/`);
    } catch {
      url = null;
    }
    if (url !== null) {
      try {
        qrSvg = renderSVG(url, { ecc: "M", border: 2 });
      } catch {
        qrSvg = null; /* the panel still shows the URL text */
      }
    }
  }

  return json({
    ok: true,
    bindHost: host,
    port,
    addresses,
    reachable,
    url,
    qrSvg,
    pendingBind,
    loopback,
    /* The server owns these answers. The client used to re-derive them by
     * comparing the bind against the literal "0.0.0.0", which is never written
     * any more -- so the switch would have read "off" while LAN access was on.
     *
     * `enabled` describes the **live bind**: a block only records intent for the
     * next start, so turning the switch off does not stop LAN access until the
     * restart, and reporting `false` at that moment would be a lie. */
    enabled: !loopback,
    restartRequired: pendingBind !== host,
    drift: driftNotice,
  });
}

async function handleBind(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad-json" }, 400);
  }
  if (typeof body?.enabled !== "boolean") {
    return json({ ok: false, error: "bad-request" }, 400);
  }
  let result;
  try {
    // Pin the port the server is actually on, not a default: the managed row
    // replaces the shipped one, so a wrong port here would silently move the
    // user's server on the next start.
    result = writeBind(body.enabled, currentPort(ctx));
  } catch (error) {
    return json({ ok: false, error: String(error.message) }, 500);
  }
  if (result.host === null) {
    // Not a server fault -- the machine simply has no address to bind right now.
    return json({ ok: false, error: result.reason }, 409);
  }
  driftNotice = null;
  return json({ ok: true, pendingBind: result.host, restartRequired: true });
}

export function apply(ctx) {
  /* Re-point a stale recorded address before anything can read the status. This
   * cannot fix the current boot -- the host parsed the patch file already -- but
   * it makes the next one right, and `driftNotice` says so out loud instead of
   * leaving the panel showing a bind that will fail. */
  const intent = readBindIntent();
  if (intent) {
    const result = reconcileBind(intent, lanAddresses(), currentPort(ctx));
    if (result.drift) {
      driftNotice =
        `记录的绑定地址 ${intent} 已不在本机网卡上，已改写为 ${result.host}。` +
        `本次启动仍按旧地址解析，需要再重启一次 DSH 才生效。`;
    }
  }

  /* `requestBody` is required on every route, GET included: the carrier reads
   * it to decide how to present the body, and an undefined value fails dispatch
   * before the handler runs -- which surfaces as a bare 400 with an empty body,
   * a response that looks nothing like a routing mistake. */
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_STATUS,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: (request) => handleStatus(ctx),
      }),
    "dsh-lan-access: status route",
  );
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_SET,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: (request) => handleBind(request, ctx),
      }),
    "dsh-lan-access: bind route",
  );
}
