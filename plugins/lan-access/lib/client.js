window.__ModuleLoader__.load({
	id: "dsh-lan-access",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var reactDom = require("react-dom");
		var h = React.createElement;

		var ROUTE_STATUS = "/api/dsh-lan-access/status";
		var ROUTE_SET = "/api/dsh-lan-access/bind";

		/* ------------------------------------------------------------------
		 * Browser half of dsh-lan-access.
		 *
		 * One phone icon in the sidebar foot. Opening it asks the host half for
		 * an authenticated LAN URL and draws that URL as a QR code, so a phone
		 * on the same network can open the real Web GUI by scanning.
		 *
		 * No proxy lives here and none is needed: the host half appends the
		 * process launch token to the URL, and the phone's first request spends
		 * it for a session cookie. See the host half for the full reasoning.
		 * ------------------------------------------------------------------ */

		var CSS = [
			".dla-btn{display:flex;align-items:center;gap:8px;width:100%;",
			"padding:7px 8px;border:0;border-radius:8px;background:transparent;",
			"color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;",
			"font-size:13px;text-align:left}",
			".dla-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dla-btn[data-rail='1']{justify-content:center;padding:7px 0}",
			".dla-btn svg{flex:none}",

			".dla-scrim{position:fixed;inset:0;z-index:2147483000;display:flex;",
			"align-items:center;justify-content:center;padding:20px;overflow:auto;",
			"background:rgba(20,20,19,.34);-webkit-backdrop-filter:blur(10px);",
			"backdrop-filter:blur(10px);",
			"font-family:var(--dsw-font-family,-apple-system,sans-serif)}",

			".dla-card{width:100%;max-width:440px;overflow:hidden;",
			"background:var(--dsw-alias-bg-overlay,#faf9f5);",
			"color:var(--dsw-alias-label-primary,#141413);",
			"border:1px solid var(--dsw-alias-border-l2,#e6dfd8);border-radius:12px;",
			"box-shadow:0 30px 70px -16px rgba(0,0,0,.34)}",

			".dla-head{display:flex;align-items:center;gap:9px;padding:13px 18px;",
			"border-bottom:1px solid var(--dsw-alias-border-l1,#ebe6df);",
			"font-size:13px;font-weight:500}",
			".dla-dot{width:7px;height:7px;border-radius:50%;flex:none;",
			"background:var(--dsw-alias-brand-primary,#d97757)}",

			".dla-body{padding:16px 18px 18px}",
			".dla-label{font-size:11.5px;font-weight:500;letter-spacing:.06em;",
			"text-transform:uppercase;margin-bottom:9px;",
			"color:var(--dsw-alias-label-tertiary,#8a8781)}",

			/* The white box hugs the code rather than stretching the full card
			 * width: the surrounding white IS the quiet zone a scanner needs,
			 * so it belongs tight around the modules, not spread across 400px
			 * of empty card. */
			".dla-qr{width:fit-content;margin:0 auto;padding:24px;",
			"border-radius:10px;background:#fff;",
			"border:1px solid var(--dsw-alias-border-l1,#ebe6df)}",
			/* An inline SVG with only a viewBox has no intrinsic size in some
			 * engines, so the box is set explicitly. */
			".dla-qr svg{display:block;width:224px;height:224px}",

			".dla-url{margin-top:10px;padding:8px 10px;border-radius:8px;",
			"font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;",
			"line-height:1.5;word-break:break-all;",
			"background:var(--dsw-alias-bg-layer-1,#f5f0e8);",
			"color:var(--dsw-alias-label-secondary,#6c6a64)}",

			".dla-note{margin-top:12px;font-size:12px;line-height:1.6;",
			"color:var(--dsw-alias-label-tertiary,#8a8781)}",

			".dla-warn{margin-top:12px;padding:10px 12px;border-radius:8px;",
			"font-size:12px;line-height:1.6;",
			"background:var(--dsw-alias-state-warn-bg,rgba(217,119,87,.12));",
			"color:var(--dsw-alias-label-primary,#141413)}",

			".dla-row{display:flex;align-items:center;gap:10px;margin-top:16px;",
			"padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,#ebe6df)}",
			".dla-switch{display:flex;align-items:center;gap:8px;font-size:13px;",
			"cursor:pointer;flex:1}",
			".dla-switch input{width:15px;height:15px;cursor:pointer}",

			".dla-btn2{font:inherit;font-size:13px;font-weight:500;padding:7px 14px;",
			"border-radius:999px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#e6dfd8);",
			"background:transparent;color:var(--dsw-alias-label-primary,#141413)}",
			".dla-btn2.primary{background:var(--dsw-alias-brand-primary,#d97757);",
			"border-color:var(--dsw-alias-brand-primary,#d97757);color:#fff}",
			".dla-btn2:disabled{opacity:.55;cursor:default}",

			".dla-addr{font-size:12px;font-family:'JetBrains Mono',ui-monospace,monospace;",
			"color:var(--dsw-alias-label-secondary,#6c6a64);margin-top:4px}",
		].join("");

		/* A phone outline, drawn inline so the row needs no icon package. */
		function PhoneIcon() {
			return h(
				"svg",
				{
					width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
					stroke: "currentColor", strokeWidth: 1.8,
					strokeLinecap: "round", strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				h("rect", { x: 7, y: 2.5, width: 10, height: 19, rx: 2.4 }),
				h("line", { x1: 11, y1: 18.4, x2: 13, y2: 18.4 }),
			);
		}

		async function requestJson(url, options) {
			var response = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
			var body = await response.json().catch(function () { return null; });
			return { ok: response.ok, status: response.status, body: body };
		}

		/**
		 * Copy text, with a fallback for plain-HTTP pages.
		 *
		 * `navigator.clipboard` only exists in a secure context (HTTPS, or
		 * localhost). This panel is served over `http://<lan-ip>:<port>` from a
		 * phone, which is NOT secure, so the modern API is `undefined` there --
		 * calling it threw a TypeError that the old `try/catch` swallowed, so the
		 * button looked dead. `execCommand('copy')` on a temporary selection
		 * still works in that context, so it is tried second.
		 *
		 * @returns whether the text actually reached the clipboard.
		 */
		function copyText(text) {
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text);
					return true;
				}
			} catch (e) { /* fall through to the legacy path */ }
			try {
				var area = document.createElement("textarea");
				area.value = text;
				/* Off-screen rather than hidden: `display:none` is not selectable,
				 * and iOS refuses to copy from it. */
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				area.setSelectionRange(0, text.length);
				var ok = document.execCommand("copy");
				document.body.removeChild(area);
				return ok;
			} catch (e) {
				return false;
			}
		}

		/** The panel: bind switch, QR, and the authenticated URL as text. */
		function LanPanel(props) {
			var state = React.useState(null);
			var info = state[0];
			var setInfo = state[1];
			var errState = React.useState("");
			var error = errState[0];
			var setError = errState[1];
			var copiedState = React.useState(false);
			var copied = copiedState[0];
			var setCopied = copiedState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var refreshingState = React.useState(false);
			var refreshing = refreshingState[0];
			var setRefreshing = refreshingState[1];

			/* `quiet` is the mount-time call: it must not flip the button into its
			 * busy state, or the panel would open looking like it was already
			 * working. The manual refresh passes nothing, so it shows the state. */
			function load(quiet) {
				if (quiet !== true) setRefreshing(true);
				requestJson(ROUTE_STATUS).then(function (result) {
					if (!result.ok || !result.body || result.body.ok !== true) {
						setError("状态读取失败");
						return;
					}
					setError("");
					setInfo(result.body);
				}).catch(function () { setError("状态读取失败"); })
					.then(function () { setRefreshing(false); });
			}

			/* The panel remounts on every open (LanEntry renders it only while
			 * open), so the mount-time fetch is already "fetch when opened" --
			 * the previous bug was reading once per *page* lifetime. On top of
			 * that, poll while visible: the URL embeds a per-launch token, so a
			 * DSH restart behind this tab must be picked up without anyone
			 * pressing anything. Hidden time does no work and no catch-up
			 * burst -- the pattern the shipped panels use. */
			React.useEffect(function () {
				load(true);
				var timer = window.setInterval(function () {
					if (document.visibilityState !== "hidden") load(true);
				}, 5000);
				return function () { window.clearInterval(timer); };
			}, []);

			function toggle(enabled) {
				setBusy(true);
				requestJson(ROUTE_SET, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled: enabled }),
				}).then(function (result) {
					setBusy(false);
					if (!result.ok || !result.body || result.body.ok !== true) {
						setError("写入失败：" + ((result.body && result.body.error) || result.status));
						return;
					}
					setError("");
					/* Quiet: the switch already reports its own progress, and the
					 * URL does not change here -- only `pendingBind` does. */
					load(true);
				}).catch(function () { setBusy(false); setError("写入失败"); });
			}

			var body = [];

			// The QR, when a URL could be minted.
			if (info && info.reachable && info.url) {
				body.push(h("div", { className: "dla-label", key: "l1" }, "扫码打开"));
				body.push(
					h("div", {
						className: "dla-qr",
						key: "qr",
						/* The SVG string arrives finished from the status
						 * payload -- generated by `uqr` on the host, never
						 * from user input -- so it is inlined as-is. One
						 * payload, one render: the code on screen cannot
						 * fall out of step with the URL beside it. */
						dangerouslySetInnerHTML: { __html: info.qrSvg || "" },
					}),
				);
				body.push(h("div", { className: "dla-url", key: "u" }, info.url));
				body.push(
					h("div", { className: "dla-note", key: "n1" },
						"手机需与本机在同一网络。扫开后就是完整的 DSH 界面，没有第二个 App。"),
				);
			} else if (info) {
				body.push(h("div", { className: "dla-label", key: "l1" }, "还没打开局域网访问"));
				body.push(
					h("div", { className: "dla-note", key: "n2" },
						"下面打开开关并重启 DSH，这里就会出现二维码。"),
				);
			} else {
				body.push(h("div", { className: "dla-note", key: "n3" }, "读取中…"));
			}

			// The switch.
			if (info) {
				/* The server answers this now. Comparing the live bind against the
				 * literal "0.0.0.0" used to be the test, and since the bind is a
				 * concrete interface address that comparison is always false -- the
				 * switch would read "off" while the machine was reachable. */
				var enabled = info.enabled === true;
				body.push(
					h(
						"div",
						{ className: "dla-row", key: "row" },
						h(
							"label",
							{ className: "dla-switch" },
							h("input", {
								type: "checkbox",
								checked: enabled,
								disabled: busy,
								onChange: function (e) { toggle(e.target.checked); },
							}),
							h("span", null, "局域网访问"),
						),
					),
				);
				/* A stale recorded address was rewritten during this start. The
				 * host parses the patch file before any plugin runs, so the fix only
				 * lands on the next boot -- without this line the panel would show a
				 * QR for an address the machine no longer owns. */
				if (info.drift) {
					body.push(
						h("div", { className: "dla-warn", key: "dr" }, info.drift),
					);
				}
				if (info.loopback && info.pendingBind) {
					body.push(
						h("div", { className: "dla-note", key: "pr" },
							"配置已写入（绑定 " + info.pendingBind + "）。重启 DSH 后生效。"),
					);
				}
				if (!info.loopback && !info.pendingBind) {
					body.push(
						h("div", { className: "dla-note", key: "pr2" },
							"当前是局域网绑定，但开关已关。重启 DSH 后回到仅本机。"),
					);
				}
				if (info.addresses && info.addresses.length) {
					body.push(
						h("div", { className: "dla-addr", key: "a" },
							info.addresses.map(function (a) { return a.address; }).join("  ·  ")),
					);
				}

				if (enabled || (info.loopback && info.pendingBind)) {
					body.push(
						h("div", { className: "dla-warn", key: "w" },
							"打开后，能连到 " + (info.port || 3080) + " 端口的人就能控制这台机器上的 agent。" +
							"这条链接本身就是凭证，别发给别人。只在可信网络里开。"),
					);
				}
			}

			if (error) {
				body.push(h("div", { className: "dla-warn", key: "err" }, error));
			}

			var close = h(
				"button",
				{ className: "dla-btn2", type: "button", onClick: props.onClose, key: "c" },
				"关闭",
			);
			/* The URL carries a token minted once per DSH process. Restarting DSH
			 * mints a new one, but a page that stays open keeps showing the old
			 * code -- it is only fetched on mount. This button re-reads it, so a
			 * restart does not require reloading the whole page. */
			var refresh = h(
				"button",
				{
					className: "dla-btn2",
					type: "button",
					onClick: function () { load(); },
					disabled: refreshing,
					key: "r",
				},
				refreshing ? "刷新中…" : "刷新",
			);
			var copy = h(
				"button",
				{
					className: "dla-btn2 primary", type: "button", key: "cp",
					onClick: function () {
						var text = (info && info.url) || "";
						if (!text) return;
						if (copyText(text)) {
							setCopied(true);
							window.setTimeout(function () { setCopied(false); }, 1600);
						} else {
							setError("浏览器不允许自动复制，请长按上面的链接手动复制。");
						}
					},
				},
				copied ? "已复制" : "复制链接",
			);

			if (info && info.reachable && info.url) {
				body.push(
					h("div", { className: "dla-row", key: "foot" }, copy, refresh, close),
				);
			} else {
				body.push(h("div", { className: "dla-row", key: "foot2" }, refresh, close));
			}

			var card = h(
				"div",
				{ className: "dla-card" },
				h(
					"div",
					{ className: "dla-head" },
					h("span", { className: "dla-dot" }),
					h("span", null, "手机访问"),
				),
				h("div", { className: "dla-body" }, body),
			);

			/* Portalled to document.body, not rendered in place. This panel is
			 * mounted inside `sidebar.footer.action`, which is a scrolling column
			 * whose ancestor clips overflow -- a fixed-position scrim drawn there
			 * gets clipped to the column, so the buttons at the bottom of the card
			 * are painted outside the clickable area and appear dead. The shipped
			 * menus hit the same thing and solve it the same way. */
			return reactDom.createPortal(
				h(
					"div",
					{
						className: "dla-scrim",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": "手机访问",
						onClick: function (e) { if (e.target === e.currentTarget) props.onClose(); },
					},
					card,
				),
				document.body,
			);
		}


		/** The sidebar-foot entry. */
		function LanEntry(props) {
			var state = React.useState(false);
			var open = state[0];
			var setOpen = state[1];
			var wide = props && props.wide;

			return h(
				React.Fragment,
				null,
				h(
					"button",
					{
						type: "button",
						className: "dla-btn",
						"data-rail": wide ? "0" : "1",
						title: "手机访问",
						"aria-label": "手机访问",
						onClick: function () { setOpen(true); },
					},
					h(PhoneIcon),
					wide ? h("span", null, "手机访问") : null,
				),
				open ? h(LanPanel, { onClose: function () { setOpen(false); } }) : null,
			);
		}

		function apply(ctx) {
			ctx.effect(function () {
				var el = document.createElement("style");
				el.id = "dsh-lan-access:styles";
				el.textContent = CSS;
				document.head.appendChild(el);
				return function () { if (el.parentNode) el.parentNode.removeChild(el); };
			}, "dsh-lan-access:styles");

			var slots = ctx.get("slots");
			if (slots === undefined) return;

			slots.inject("sidebar.footer.action", function () {
				try {
					return slots.register(
						{ name: "sidebar.footer.action", id: "lan-access", order: 20 },
						LanEntry,
					);
				} catch (e) {
					return function () {};
				}
			});
		}

		exports.name = "dsh-lan-access";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	},
});
