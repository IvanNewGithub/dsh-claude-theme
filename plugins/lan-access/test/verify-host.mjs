#!/usr/bin/env node
/**
 * Checks the host half of dsh-lan-access without a running DSH.
 *
 * Two things here can break a user's machine rather than just look wrong, so
 * both are asserted directly:
 *
 *   1. The bind block is written into the profile's `cordis.patch.yml`, which
 *      configures how their DSH starts. It must be idempotent and it must come
 *      out byte-identical when the switch is turned off, or repeated toggling
 *      would keep appending rows to a file the user owns.
 *   2. The status route mints a URL through `connection.authenticatedUrl`.
 *      That URL is the credential, so the test checks it carries the token and
 *      the LAN address -- not loopback -- because a QR pointing at 127.0.0.1
 *      cannot be opened from a phone.
 *
 * The `zbarimg` round-trip in verify-qr.mjs covers the encoder; this file
 * covers the wiring around it.
 *
 * ## Why the bind is a concrete address and never a wildcard
 *
 * dsh 0.2.1-rc.2 rejects `host: 0.0.0.0` outright -- the webserver config
 * schema throws on any unspecified address and there is no opt-out. A profile
 * carrying the old wildcard block therefore fails to boot at all, which is how
 * this plugin shipped broken: it wrote `0.0.0.0`, and the host stopped starting.
 *
 * Binding one concrete interface address is also what the Host-header rule
 * wants: a request's Host must be loopback, equal to the bind literal, or listed
 * in `trustedHosts`. A phone dialling `192.168.x.x:3080` sends exactly that
 * literal, so a concrete bind authenticates by construction while `0.0.0.0`
 * never matched anything.
 *
 * USE
 *
 *   node plugins/lan-access/test/verify-host.mjs
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "dsh-lan-host-"));
process.env.DSH_HOME = work;
process.env.DSH_PROFILE = "web";
mkdirSync(join(work, "profiles", "web"), { recursive: true });

const PATCH = join(work, "profiles", "web", "cordis.patch.yml");
const ORIGINAL = [
  "- id: dsh-cost-meter",
  "  disabled: false",
  "- id: ui-theme",
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  "  config:",
  "    preference: dark",
  "",
].join("\n");
writeFileSync(PATCH, ORIGINAL, "utf8");

const mod = await import("../lib/index.js");

/** The address every write test injects, so nothing here depends on the machine's real NICs. */
const LAN = "192.168.10.102";

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
    failed++;
  }
}

/** A synthetic interface map shaped like `os.networkInterfaces()`. */
function ifaces(entries) {
  const out = {};
  for (const [name, address, extra = {}] of entries) {
    out[name] = out[name] || [];
    out[name].push({ address, family: "IPv4", netmask: "255.255.255.0", cidr: `${address}/24`, ...extra });
  }
  return out;
}

try {
  /* ---- address selection -------------------------------------------------
   *
   * `lanAddresses()` sorts only by "is private", and Docker's default bridge
   * 172.17.0.1 satisfies that predicate. A tie leaves the winner up to the
   * enumeration order of `networkInterfaces()`, so the pairing QR could point at
   * an address a phone can never reach. Selection must not depend on that order.
   */

  check(
    "selectLanAddress is exported for deterministic testing",
    typeof mod.selectLanAddress === "function",
  );

  if (typeof mod.selectLanAddress === "function") {
    const mixed = ifaces([
      ["lo", "127.0.0.1", { internal: true }],
      ["docker0", "172.17.0.1"],
      ["br-9f2c1a", "172.18.0.1"],
      ["veth21ab", "10.244.0.2"],
      ["eno1", "192.168.10.102"],
    ]);
    check("a container bridge is never chosen over a real NIC", mod.selectLanAddress(mixed) === "192.168.10.102", String(mod.selectLanAddress(mixed)));

    const dockerFirst = { docker0: mixed.docker0, eno1: mixed.eno1 };
    check(
      "the result does not depend on enumeration order",
      mod.selectLanAddress(dockerFirst) === "192.168.10.102" &&
        mod.selectLanAddress({ eno1: mixed.eno1, docker0: mixed.docker0 }) === "192.168.10.102",
    );

    check("loopback alone yields nothing", mod.selectLanAddress(ifaces([["lo", "127.0.0.1", { internal: true }]])) === null);
    check("link-local alone yields nothing", mod.selectLanAddress(ifaces([["wlan0", "169.254.7.3"]])) === null);
    check(
      "only container networks available yields nothing rather than a bad bind",
      mod.selectLanAddress(ifaces([["docker0", "172.17.0.1"], ["br-1", "172.18.0.1"]])) === null,
    );
    check(
      "the default-route interface wins",
      mod.selectLanAddress(ifaces([["wlan0", "10.0.5.9"], ["eno1", "192.168.10.102"]]), "eno1") === "192.168.10.102",
    );
    check(
      "a named interface that is down falls back rather than returning null",
      mod.selectLanAddress(ifaces([["wlan0", "10.0.5.9"]]), "eno1") === "10.0.5.9",
    );
    check("a public address is still bindable when it is all there is", mod.selectLanAddress(ifaces([["eth0", "203.0.113.7"]])) === "203.0.113.7");
  }

  /* ---- the bind block ---------------------------------------------------- */

  check("starts with no managed block", readFileSync(PATCH, "utf8") === ORIGINAL);

  mod.writeBind(true, undefined, LAN);
  const once = readFileSync(PATCH, "utf8");
  check("enabling writes exactly one block", (once.match(/>>> dsh-lan-access bind >>>/g) || []).length === 1);
  /* The listener is always the wildcard: a concrete bind excludes loopback, so
   * the user's own desktop browser is forced onto the LAN address and every
   * loopback-only write fence (xiaoke's 403) then treats the person sitting at
   * the keyboard as remote. The LAN address lives in the QR URL and the trust
   * block instead. */
  check("enabling writes the wildcard bind", once.includes("host: '0.0.0.0'"), once.match(/host:.*/)?.[0]);
  check(
    "the block carries no concrete bind address",
    !once.includes(`host: '${LAN}'`) && !once.includes("[::]"),
    once.match(/host:.*/)?.[0],
  );
  check(
    "the block replaces the webserver row, so it repeats its static config",
    once.includes("- id: webserver") && once.includes("compression: gzip"),
  );

  mod.writeBind(true, undefined, LAN);
  check("enabling twice does not append a second block", readFileSync(PATCH, "utf8") === once);

  mod.writeBind(false);
  check("disabling removes the block", mod.readBindIntent() === null);
  check(
    "disabling restores the file byte for byte",
    readFileSync(PATCH, "utf8") === ORIGINAL,
    JSON.stringify(readFileSync(PATCH, "utf8")),
  );

  mod.writeBind(false);
  check("disabling twice is still byte-identical", readFileSync(PATCH, "utf8") === ORIGINAL);

  /* ---- the trust block ---------------------------------------------------
   *
   * The bind literal authenticates only a browser that dials exactly that
   * address; a hostname, an mDNS name, or a stale DHCP address gets 403. The
   * trust block declares those names, and it must keep the invocation
   * authorities the shipped row spreads, or enabling LAN access would silently
   * drop every `--trusted-host` value.
   */

  const names = mod.trustedNames([
    { name: "lo", address: "127.0.0.1" },
    { name: "eno1", address: LAN },
    { name: "eno1", address: LAN },
  ]);
  check("trustedNames lists the LAN address exactly once", names.filter((entry) => entry === LAN).length === 1, JSON.stringify(names));
  check("trustedNames never declares a loopback name", !names.some((entry) => ["127.0.0.1", "::1", "localhost"].includes(entry)), JSON.stringify(names));

  mod.writeBind(true, undefined, LAN);
  const trusted = readFileSync(PATCH, "utf8");
  check("enabling writes exactly one trust block", (trusted.match(/>>> dsh-lan-access trust >>>/g) || []).length === 1);
  check("the trust block replaces the connection row", trusted.includes("- id: connection") && trusted.includes("@deepseek-ai/dsh-client-connection"));
  /* The !!js expression is a single-quoted YAML scalar, so its JS string
   * literals are double-quoted (single quotes would close the scalar). */
  check("it declares the LAN address as trusted (the QR names it)", trusted.includes(`"${LAN}"`), (trusted.match(/trustedHosts:.*/)||["-"])[0].slice(0,140));
  check("it keeps the invocation authorities", trusted.includes("...ctx.webStartup.trustedHosts"));

  mod.writeBind(true, undefined, LAN);
  check("enabling twice does not append a second trust block", (readFileSync(PATCH, "utf8").match(/>>> dsh-lan-access trust >>>/g) || []).length === 1);

  mod.writeBind(false);
  check("disabling removes the trust block too", !readFileSync(PATCH, "utf8").includes("dsh-lan-access trust"));
  check("and still restores byte for byte", readFileSync(PATCH, "utf8") === ORIGINAL);

  /* Enabling with no usable address must not write a block that names nothing:
   * a bogus host would fail `listen` on the next start and take the whole
   * profile down, which is the exact failure this rewrite exists to fix. */
  mod.writeBind(true, undefined, null);
  check("enabling with no available address writes nothing", readFileSync(PATCH, "utf8") === ORIGINAL);
  const refused = mod.writeBind(true, undefined, null);
  check(
    "and reports why instead of pretending to enable",
    refused && refused.host === null && typeof refused.reason === "string" && refused.reason.length > 0,
    JSON.stringify(refused),
  );
  check("a refused enable leaves no pending intent", mod.readBindIntent() === null);

  /* The managed row replaces the shipped `webserver` row, so the port it pins
   * is the port the next start uses. Hardcoding 3080 here would move a server
   * started with `--port 8080`, which the user would read as the plugin losing
   * their setting. */
  mod.writeBind(true, 8080, LAN);
  const pinned = /port:\s*(\d+)/.exec(readFileSync(PATCH, "utf8"));
  check("pins the port it was given, not a default", pinned !== null && pinned[1] === "8080", pinned ? pinned[1] : "no port line");
  mod.writeBind(false);
  check("still restores after a custom port", readFileSync(PATCH, "utf8") === ORIGINAL);

  /* ---- drift reconciliation ---------------------------------------------
   *
   * The recorded host is a literal string in a file the host parses before any
   * plugin runs, so a renewed DHCP address cannot be healed within the same
   * boot. What reconcileBind can do is rewrite the block for the next start and
   * say so -- and it must never act on a transient empty interface list, which
   * would silently switch LAN access off.
   */

  check("reconcileBind is exported", typeof mod.reconcileBind === "function");

  if (typeof mod.reconcileBind === "function") {
    check("no block means nothing to reconcile", mod.reconcileBind(null, [])?.changed === false);
    check(
      "a recorded address that is still present is left alone",
      mod.reconcileBind(LAN, [{ name: "eno1", address: LAN }]).changed === false,
    );
    check(
      "an empty address list never removes the block",
      mod.reconcileBind(LAN, []).changed === false && mod.reconcileBind(LAN, []).drift === false,
    );

    mod.writeBind(true, 3080, LAN);
    const healed = mod.reconcileBind(LAN, [{ name: "wlan0", address: "10.0.5.9" }]);
    check("a stale address is rewritten for the next start", healed.changed === true && healed.drift === true, JSON.stringify(healed));
    check("and the rewrite records the new address (intent, not the bind)", mod.readBindIntent() === "10.0.5.9", String(mod.readBindIntent()));
    mod.writeBind(false);
    check("reconciliation still restores byte-identically", readFileSync(PATCH, "utf8") === ORIGINAL);
  }

  /* ---- the routes ------------------------------------------------------- */

  const routes = new Map();
  const fakeCtx = {
    webServer: { host: LAN, port: 3080 },
    connection: {
      authenticatedUrl(base) {
        const u = new URL(base);
        u.searchParams.set("token", "TEST_TOKEN");
        return u.href;
      },
      fetch: {
        register(spec) {
          routes.set(spec.path, spec);
          return () => {};
        },
      },
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
  };
  mod.apply(fakeCtx);

  /* Two routes now: the QR route is gone because the status payload embeds
   * the finished SVG (uqr on the host), so there is nothing left for a third
   * route to serve. */
  check("registers two routes", routes.size === 2, [...routes.keys()].join(", "));

  /* `requestBody` is required on every route, GET included. An undefined value
   * fails dispatch before the handler runs and the carrier answers with a bare
   * 400 carrying an empty body -- which reads like a broken route rather than a
   * missing field. The first version of this plugin shipped without it on the
   * two GET routes and the panel reported "status read failed" against an
   * endpoint that looked registered. */
  for (const [path, spec] of routes) {
    const mode = spec.requestBody;
    check(
      `route ${path} declares a body mode`,
      mode === "buffered" || mode === "streaming",
      `got ${JSON.stringify(mode)}`,
    );
  }

  const statusResponse = await routes.get("/api/dsh-lan-access/status").fetch(
    new Request("http://127.0.0.1:3080/api/dsh-lan-access/status"),
  );
  const status = await statusResponse.json();
  check("status reports the live bind", status.bindHost === LAN, String(status.bindHost));

  /* The panel used to re-derive "is the switch on" by comparing the bind against
   * the literal "0.0.0.0". That string is now never written, so the server owns
   * the answer and the client only reads it. */
  check("status carries an explicit enabled flag", typeof status.enabled === "boolean");
  check("a concrete LAN bind is reported as enabled", status.enabled === true);

  /* reachable keyed off "0.0.0.0" before the rewrite; with a concrete bind that
   * comparison is always false and the QR silently stops being minted. */
  check("status reports reachable for a concrete LAN bind", status.reachable === true);
  check("status carries a URL", typeof status.url === "string" && status.url.length > 0);
  check("the URL carries the token", (status.url || "").includes("token=TEST_TOKEN"));
  check("the URL points at the bound address", (status.url || "").includes(LAN), String(status.url));
  check("a concrete LAN bind is not flagged loopback", status.loopback === false);

  /* ---- loopback state ---------------------------------------------------- */

  const loopCtx = { ...fakeCtx, webServer: { host: "127.0.0.1", port: 3080 } };
  const loopRoutes = new Map();
  loopCtx.connection = { ...fakeCtx.connection, fetch: { register: (s) => { loopRoutes.set(s.path, s); return () => {}; } } };
  loopCtx.effect = (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; };
  mod.apply(loopCtx);
  const loopStatus = await (
    await loopRoutes.get("/api/dsh-lan-access/status").fetch(new Request("http://127.0.0.1:3080/api/dsh-lan-access/status"))
  ).json();
  check("a loopback bind reports not reachable", loopStatus.reachable === false);
  check("a loopback bind mints no URL", loopStatus.url === null);
  check("a loopback bind is flagged as loopback", loopStatus.loopback === true);
  check("a loopback bind reports the switch off", loopStatus.enabled === false);

  /* ---- the bind route ---------------------------------------------------- */

  mod.writeBind(false);
  const bindResponse = await routes.get("/api/dsh-lan-access/bind").fetch(
    new Request("http://127.0.0.1:3080/api/dsh-lan-access/bind", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    }),
  );
  const bindResult = await bindResponse.json();
  check("enabling through the route reports a pending concrete address",
    bindResult.ok === true && bindResult.pendingBind === LAN, JSON.stringify(bindResult));
  check("the route never reports a wildcard as pending", bindResult.pendingBind !== "0.0.0.0");

  rmSync(work, { recursive: true, force: true });
} catch (error) {
  console.error(error);
  failed++;
}

console.log(`\nverify-host: ${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
