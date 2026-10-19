/**
 * dsh-session-multiselect — Web client bundle.
 *
 * Adds a multi-select panel for conversations to the DSH Web GUI. The native
 * sidebar owns its session rows through a `single` slot with no per-row
 * extension point, so this plugin never touches those rows: it injects its own
 * entry button into the session-list toolbar (the DOM injection below) and also
 * registers the declared `sidebar.footer.action` slot as the guaranteed way in,
 * then renders a self-contained panel over the module-provided Session list.
 *
 * Contract notes that shaped this file:
 * - `dsh.client.inject` in package.json is MODULE-GRAPH arrival order, not
 *   Cordis service injection; the service gate is the exported `inject` array.
 * - Session-list data never enters zustand: it is read through the `sessions`
 *   service with `getSnapshot()`/`subscribe()` (a uSES pair), and both snapshot
 *   shapes the controller can hand out are accepted (see `snapshotItems`).
 * - Batch actions are delete / archive / pin. Deleting runs in the Node half —
 *   the client session service has no `delete` — so it is one
 *   `GET /session-multiselect/delete?ids=…` request whose per-id results become
 *   the same failure list the archive and pin commands report.
 * - The Harness client packages this bundle would like to borrow (primitives,
 *   client-store) are OPTIONAL and resolved defensively: DSH 0.2 seeds only
 *   React, Cordis, and static libraries, and its own authoring guide says not to
 *   require a Harness client package as a module at all. A missing module here
 *   must cost chrome, never the plugin — which is why every one of them has a
 *   local implementation behind the same calls.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-multiselect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * Resolve a module the running client may or may not seed.
		 *
		 * A Harness client package is not part of the guaranteed baseline (0.2
		 * seeds React, Cordis, and static libraries only), and a bare `require` of
		 * one that is absent throws while the bundle is being materialized — which
		 * would take the whole plugin down, entry button and all. So each optional
		 * module is wrapped, and the callers below fall back to their own copy.
		 * @param id - module id to resolve.
		 * @returns the module, or an empty stand-in.
		 */
		const optionalRequire = (id) => {
			try {
				const found = require(id);
				return found === null || found === undefined ? {} : found;
			} catch {
				return {};
			}
		};
		const clientStore = optionalRequire("@deepseek-ai/dsh-client-store");
		const primitives = optionalRequire("@deepseek-ai/dsh-client-ui-primitives");
		const react = require("react");
		const reactDom = require("react-dom/client");
		const { jsx, jsxs } = require("react/jsx-runtime");
		/**
		 * `createPortal`, which lives on `react-dom` — NOT on `react-dom/client`,
		 * the module this bundle takes `createRoot` from. Resolved defensively: with
		 * no portal at all the dialog still renders (its mask is `position:fixed`,
		 * so it covers the window from wherever it is mounted).
		 */
		const reactDomFull = optionalRequire("react-dom");
		const createPortal = typeof reactDomFull.createPortal === "function"
			? reactDomFull.createPortal
			: (typeof reactDom.createPortal === "function" ? reactDom.createPortal : null);

		// ---------------------------------------------------------------------
		// Optional Harness chrome, with this bundle's own copies behind it
		//
		// Everything the plugin borrows from the client platform is resolved once,
		// here, into a table with the same call signatures. A build that seeds the
		// platform packages gets their native look; a build that does not (0.2
		// seeds only React, Cordis, and static libraries) gets these, and either way
		// the feature is present. Two behaviours are deliberately copied rather
		// than dropped: the dialog closes on Escape and on a mask click, and the
		// tooltip attaches its label to the anchor instead of wrapping it.
		// ---------------------------------------------------------------------

		/** A `createSnapshotStore` stand-in: getSnapshot / subscribe / set. */
		function createLocalSnapshotStore(init) {
			let state = init;
			const listeners = new Set();
			return {
				getSnapshot: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
				set(next) {
					state = next;
					for (const listener of [...listeners]) {
						try {
							listener();
						} catch {
							/* a listener must not break the store it reads */
						}
					}
				}
			};
		}

		/**
		 * A `defineStore` stand-in with the one feature this plugin leans on.
		 *
		 * Persistence is not decoration here: the grouping preference and the
		 * plugin's own archived marks are read on the next open, so they have to
		 * survive a restart. Storage
		 * failures (a full quota, a disabled store) cost the memory of that
		 * preference, never the action itself.
		 * @param declaration - the same shape the platform store takes.
		 * @returns `{ create() }`, matching the call site.
		 */
		function defineLocalStore(declaration) {
			return {
				create() {
					const seed = () => {
						const initial = declaration.init();
						if (typeof declaration.persist !== "string" || typeof localStorage === "undefined") return initial;
						try {
							const raw = localStorage.getItem(declaration.persist);
							if (raw === null) return initial;
							const parsed = JSON.parse(raw);
							return parsed !== null && typeof parsed === "object" ? { ...initial, ...parsed } : initial;
						} catch {
							return initial;
						}
					};
					const snapshot = createLocalSnapshotStore(seed());
					const persist = () => {
						if (typeof declaration.persist !== "string" || typeof localStorage === "undefined") return;
						try {
							localStorage.setItem(declaration.persist, JSON.stringify(snapshot.getSnapshot()));
						} catch {
							/* the preference is a convenience; the session keeps working */
						}
					};

					const actions = {};
					for (const key of Object.keys(declaration.actions ?? {})) {
						actions[key] = (...params) => {
							const draft = { ...snapshot.getSnapshot() };
							declaration.actions[key](draft, ...params);
							snapshot.set(draft);
							persist();
						};
					}
					return { actions, getSnapshot: snapshot.getSnapshot, subscribe: snapshot.subscribe };
				}
			};
		}

		/** The store factory: the seeded one when it is complete, else this bundle's. */
		const storeApi = typeof clientStore.createSnapshotStore === "function" && typeof clientStore.defineStore === "function"
			? clientStore
			: { createSnapshotStore: createLocalSnapshotStore, defineStore: defineLocalStore };

		/** A dialog with the primitives' Modal contract: portal, mask, Escape. */
		function LocalModal({ open, onClose, title, closeLabel, description, children }) {
			react.useEffect(() => {
				if (open !== true || typeof document === "undefined") return undefined;
				const onKeyDown = (event) => {
					if (event.key === "Escape") onClose?.();
				};
				document.addEventListener("keydown", onKeyDown, true);
				return () => { document.removeEventListener("keydown", onKeyDown, true); };
			}, [open, onClose]);
			if (open !== true || typeof document === "undefined") return null;
			const tree = jsx("div", {
				className: "dsh-msel-mask",
				onClick: (event) => {
					// Only the mask itself: a click that started inside the dialog and
					// ended on the mask is not a dismissal.
					if (event.target === event.currentTarget) onClose?.();
				},
				children: jsx("div", {
					className: "dsh-msel-modal",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": title,
					children: [
						jsx("div", { className: "dsh-msel-modalHead", children: [
							jsx("span", { className: "dsh-msel-modalTitle", children: title }),
							jsx("button", {
								type: "button",
								className: "dsh-msel-modalClose",
								"aria-label": closeLabel,
								onClick: () => { onClose?.(); },
								children: "✕"
							})
						] }),
						description === undefined || description === null || description === ""
							? null
							: jsx("div", { className: "dsh-msel-modalDesc", children: description }),
						jsx("div", { className: "dsh-msel-modalBody", children })
					]
				})
			});
			return createPortal === null ? tree : createPortal(tree, document.body);
		}

		/** A button with the primitives' Button contract (variant/size are CSS here). */
		function LocalButton({ className, disabled, onClick, children, ...rest }) {
			return jsx("button", { type: "button", className, disabled, onClick, ...rest, children });
		}

		/** An input with the primitives' Input contract, icon included. */
		function LocalInput({ icon, className, ...rest }) {
			return jsx("span", {
				className: `dsh-msel-inputWrap ${className ?? ""}`.trim(),
				children: [
					icon === undefined || icon === null ? null : jsx("span", { className: "dsh-msel-inputIcon", children: icon }),
					jsx("input", { className: "dsh-msel-input", ...rest })
				]
			});
		}

		/**
		 * A tooltip that attaches its label to the anchor, like the primitives do.
		 *
		 * Only a real element can carry the label: anything else (a stand-in, a
		 * string) is returned untouched, so this can never invent a wrapper element
		 * the caller did not ask for.
		 */
		function LocalTooltip({ label, children }) {
			const canClone = typeof react.cloneElement === "function"
				&& children !== null
				&& typeof children === "object"
				&& children.$$typeof !== undefined;
			return canClone ? react.cloneElement(children, { title: label }) : children;
		}

		/**
		 * Whether an export can be rendered as a React component.
		 *
		 * Deliberately not `typeof value === "function"`: the primitives' Button and
		 * Tooltip forward refs, and `React.forwardRef` returns an OBJECT with a
		 * `$$typeof` tag. Testing for a function would have quietly replaced the
		 * platform's own button with this bundle's copy on every build.
		 * @param value - the export to test.
		 * @returns true when it is a component type.
		 */
		const isComponent = (value) => typeof value === "function"
			|| (value !== null && typeof value === "object" && typeof value.$$typeof === "symbol");

		/** The chrome this bundle draws with. */
		const ui = {
			Modal: isComponent(primitives.Modal) ? primitives.Modal : LocalModal,
			Button: isComponent(primitives.Button) ? primitives.Button : LocalButton,
			Input: isComponent(primitives.Input) ? primitives.Input : LocalInput,
			Tooltip: isComponent(primitives.Tooltip) ? primitives.Tooltip : LocalTooltip
		};
		/** Which half of that table is in use, for the diagnostic ring. */
		const chromeSource = isComponent(primitives.Modal) ? "primitives" : "local";
		// ---------------------------------------------------------------------
		// Pure helpers (no React, no DOM). Also published on
		// globalThis.__DSH_SESSION_MULTISELECT__ so this exact code path can be
		// unit tested outside a browser.
		// ---------------------------------------------------------------------

		/** Collapse whitespace to one line. */
		function inlineText(value) {
			return String(value).replace(/\s+/gu, " ").trim();
		}

		/** Local timestamp for the row metadata line. */
		function stamp(value) {
			const date = new Date(typeof value === "number" ? value : Date.now());
			if (Number.isNaN(date.getTime())) return "";
			const pad = (part) => String(part).padStart(2, "0");
			return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		/**
		 * The session summaries inside a list snapshot.
		 *
		 * The controller hands out a NORMALIZED snapshot — `ids` plus `byId` — and
		 * that is the shape every working client reads (`byId[sessionId]`,
		 * `.current`, `.phase`). An `items` array is honoured as well, because a
		 * projection that flattens the list into display order exists on the same
		 * service. Reading only one of the two is how the panel ends up listing
		 * nothing while the sidebar is full of sessions.
		 * @param snapshot - `ctx.sessions.list.getSnapshot()`.
		 * @returns the summary objects, in snapshot order.
		 */
		function snapshotItems(snapshot) {
			if (snapshot === null || snapshot === undefined) return [];
			if (Array.isArray(snapshot.items)) return snapshot.items.map((summary) => normalizeSummary(summary));
			if (!Array.isArray(snapshot.ids)) return [];
			const byId = snapshot.byId;
			if (byId === null || byId === undefined || typeof byId !== "object") return [];
			const items = [];
			for (const id of snapshot.ids) {
				const summary = byId[id];
				if (summary !== null && summary !== undefined) items.push(normalizeSummary(summary, id));
			}
			return items;
		}

		/**
		 * Give a session summary the two fields this panel keys on.
		 *
		 * The controller's `byId` values carry the session id as `id` — not
		 * `sessionId` — and derive a `displayTitle` from the title, the working
		 * directory, or the id. Reading only `sessionId`/`title` leaves EVERY row
		 * keyed on `undefined`, which is exactly how "select one row" becomes
		 * "all rows selected": they all share the same missing key, so a single
		 * toggle matches every row and every batch action targets nothing.
		 * @param summary - a summary from the list snapshot.
		 * @param key - the id it is filed under, when the snapshot is normalized.
		 * @returns the summary with `sessionId` and `title` filled in.
		 */
		function normalizeSummary(summary, key) {
			const sessionId = typeof summary.sessionId === "string" && summary.sessionId !== ""
				? summary.sessionId
				: typeof summary.id === "string" && summary.id !== "" ? summary.id : key;
			const title = typeof summary.title === "string" && summary.title !== ""
				? summary.title
				: typeof summary.displayTitle === "string" ? summary.displayTitle : "";
			return { ...summary, sessionId, title };
		}

		/**
		 * Build a translator over a dictionary pair.
		 *
		 * Kept pure so it can be tested: the plugin needs a translator of its own
		 * because the slot-provided `t` only exists once the footer registration
		 * has rendered, and showing raw keys is the visible result of waiting for
		 * it. Missing keys fall back to the other dictionary, then to the key.
		 * @param options - `zh`, `en`, and `active()` returning the locale id.
		 * @returns `(key, params) => string`.
		 */
		function makeTranslator({ zh: zhDict, en: enDict, active }) {
			return (key, params) => {
				const id = typeof active === "function" ? String(active() ?? "") : "";
				const dictionary = id.toLowerCase().startsWith("en") ? enDict : zhDict;
				const template = dictionary[key] ?? enDict[key] ?? zhDict[key] ?? key;
				if (params === undefined) return template;
				return template.replace(/\{(\w+)\}/gu, (match, name) => (params[name] === undefined ? match : String(params[name])));
			};
		}

		/**
		 * Flatten the session list into the panel's display order.
		 *
		 * Pinned rows come first (the shell groups them that way too), then newest
		 * first. Archived rows are dropped unless the caller asks for them; blank
		 * sessions are never rows, and a summary with no usable id is skipped
		 * rather than allowed to collapse every row onto one key.
		 *
		 * Subagent Sessions are skipped as well. They are session-log internals
		 * (`origin === "subagent"`, a bare-UUID id, a `parentId` pointing at the
		 * conversation that spawned them), and DSH's own sidebar never lists them —
		 * it only badges the parent with a running-child count. Listing them here
		 * made the panel show rows the user could not find anywhere else, and a
		 * group click or "select all" then put their ids in a delete batch, where
		 * the host route's `session-…` id shape used to reject the whole batch.
		 */
		function visibleRows(snapshot, state, query, showArchived, filter) {
			const items = snapshotItems(snapshot);
			const archived = new Set(state?.archivedIds ?? []);
			const pinned = new Set(state?.pinnedIds ?? []);
			const needle = String(query ?? "").trim().toLowerCase();
			const rows = [];
			for (const summary of items) {
				if (summary === null || summary === undefined) continue;
				if (summary.blank === true) continue;
				if (summary.origin === "subagent") continue;
				if (typeof summary.sessionId !== "string" || summary.sessionId === "") continue;
				const isArchived = archived.has(summary.sessionId);
				if (isArchived && !showArchived) continue;
				const title = typeof summary.title === "string" ? summary.title : "";
				if (needle !== ""
					&& !title.toLowerCase().includes(needle)
					&& !String(summary.cwd ?? "").toLowerCase().includes(needle)
					&& !summary.sessionId.toLowerCase().includes(needle)) continue;
				const isPinned = pinned.has(summary.sessionId);
				// Quick filters run after the archived/blank rules so "running" never
				// leaks a blank or hidden row.
				if (filter === "running" && summary.running !== true) continue;
				if (filter === "pinned" && !isPinned) continue;
				rows.push({
					sessionId: summary.sessionId,
					title,
					cwd: typeof summary.cwd === "string" ? summary.cwd : "",
					updatedAt: typeof summary.updatedAt === "number" ? summary.updatedAt : 0,
					running: summary.running === true,
					archived: isArchived,
					pinned: isPinned
				});
			}
			rows.sort((left, right) => {
				if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
				return right.updatedAt - left.updatedAt;
			});
			return rows;
		}

		/**
		 * Final path segment of a workspace path, for a group heading.
		 * Mirrors the shell's own label rule (`workspaceTitleOf`) so a heading
		 * reads like the workspace switcher instead of a second naming scheme.
		 * @param path - POSIX or Windows path.
		 * @returns the last segment, or an empty string for a separator-only path.
		 */
		function workspaceLabel(path) {
			const trimmed = String(path ?? "").replace(/[/\\]+$/u, "");
			const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return cut === -1 ? trimmed : trimmed.slice(cut + 1);
		}

		/**
		 * Turn a DSH workspace *directory name* back into a readable path.
		 *
		 * A session's workspace directory is named after its real path: backslashes
		 * become `-`, spaces (and other specials) are escaped as `~0020`-style
		 * units, and the whole name is wrapped in `--`. So
		 * `--G-create~0020plugin-dsh--` is `G:\create plugin-dsh`. The scheme is
		 * DSH's own and inherently ambiguous — a real hyphen is indistinguishable
		 * from a separator — so this is a label only: the raw name stays in the
		 * tooltip and restore keeps using the directory name itself.
		 * @param raw - the encoded directory name from a trash entry.
		 * @returns the readable path, or the name itself when it cannot be decoded.
		 */
		function decodeWorkspaceDir(raw) {
			const name = typeof raw === "string" ? raw : "";
			if (name === "") return "";
			const body = name.startsWith("--") && name.endsWith("--") && name.length > 4 ? name.slice(2, -2) : name;
			const decoded = body.replace(/~([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
			const slash = decoded.replace(/-/gu, "\\");
			return /^[A-Za-z]\\/.test(slash) ? `${slash[0]}:${slash.slice(1)}` : slash;
		}

		/**
		 * The visible rows as a Markdown table for the clipboard.
		 *
		 * Fields are the ones a person needs when filing a bug or moving work
		 * elsewhere: title, workspace, update time and the state tags. Pipes and
		 * newlines are escaped so one conversation cannot break the table shape.
		 * @param rows - rows from {@link visibleRows}, in display order.
		 * @param t - translator for the header and tag names.
		 * @returns the Markdown text.
		 */
		function exportMarkdown(rows, t) {
			const escape = (value) => String(value ?? "").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
			const tags = (row) => [row.pinned ? t("export.pinned") : "", row.archived ? t("export.archived") : "", row.running ? t("export.running") : ""].filter((tag) => tag !== "").join("/");
			const header = `| ${t("export.title")} | ${t("export.workspace")} | ${t("export.updated")} | ${t("export.status")} |`;
			const separator = "| --- | --- | --- | --- |";
			const lines = (Array.isArray(rows) ? rows : []).map((row) => `| ${escape(row.title === "" ? row.sessionId.slice(0, 8) : row.title)} | ${escape(row.cwd)} | ${stamp(row.updatedAt)} | ${tags(row)} |`);
			return [header, separator, ...lines].join("\n");
		}

		/**
		 * Split display rows into workspace groups.
		 *
		 * Rows arrive already ordered by {@link visibleRows} (newest first) and
		 * grouping must not disturb that: a group keeps the incoming order of its
		 * members. Groups are then ordered by their most recent
		 * member, so the workspace the user just worked in heads the list.
		 * Sessions with no recorded workspace form one trailing group — they are
		 * the ones least likely to be looked for, and separating them keeps the
		 * named headings meaningful.
		 * @param rows - rows from {@link visibleRows}.
		 * @param byWorkspace - false collapses everything into one anonymous group.
		 * @returns groups of `{ key, path, label, latest, rows }` in display order.
		 */
		function groupRows(rows, mode) {
			const list = Array.isArray(rows) ? rows : [];
			// Pre-0.10 callers passed a boolean; keep accepting both spellings.
			const kind = mode === false || mode === "none" ? "none" : mode === "date" ? "date" : "workspace";
			if (kind === "none") {
				return list.length === 0 ? [] : [{ key: "", kind, path: "", label: "", latest: 0, rows: list }];
			}
			if (kind === "date") {
				const dayStart = (value) => {
					const date = new Date(typeof value === "number" ? value : 0);
					date.setHours(0, 0, 0, 0);
					return date.getTime();
				};
				const today = dayStart(Date.now());
				const bounds = [
					["today", today, Infinity],
					["yesterday", today - 86400000, today],
					["week", today - (6 * 86400000), today - 86400000],
					["earlier", -Infinity, today - (6 * 86400000)]
				];
				const buckets = new Map();
				for (const row of list) {
					const at = typeof row?.updatedAt === "number" ? row.updatedAt : 0;
					const found = bounds.find(([, from, to]) => at >= from && at < to);
					const key = found === undefined ? "earlier" : found[0];
					const bucket = buckets.get(key);
					if (bucket === undefined) buckets.set(key, { key, kind, path: "", label: `date.${key}`, latest: at, rows: [row] });
					else {
						bucket.rows.push(row);
						if (at > bucket.latest) bucket.latest = at;
					}
				}
				return bounds.map(([key]) => buckets.get(key)).filter((group) => group !== undefined);
			}
			const groups = new Map();
			for (const row of list) {
				const cwd = typeof row?.cwd === "string" ? row.cwd : "";
				const group = groups.get(cwd);
				if (group === undefined) {
					groups.set(cwd, {
						key: cwd,
						kind,
						path: cwd,
						label: workspaceLabel(cwd),
						latest: typeof row?.updatedAt === "number" ? row.updatedAt : 0,
						rows: [row]
					});
					continue;
				}
				group.rows.push(row);
				if (typeof row?.updatedAt === "number" && row.updatedAt > group.latest) group.latest = row.updatedAt;
			}
			return [...groups.values()].sort((left, right) => {
				if ((left.path === "") !== (right.path === "")) return left.path === "" ? 1 : -1;
				return right.latest - left.latest;
			});
		}

		/**
		 * The flat display order of grouped rows.
		 *
		 * Range selection and "select all" run on this list, so it has to be the
		 * same order the panel paints — otherwise Shift+click would sweep rows the
		 * user cannot see between the two clicks.
		 * @param groups - groups from {@link groupRows}.
		 * @returns every row, groups laid out in order.
		 */
		function flattenGroups(groups) {
			const rows = [];
			for (const group of Array.isArray(groups) ? groups : []) {
				for (const row of Array.isArray(group?.rows) ? group.rows : []) rows.push(row);
			}
			return rows;
		}

		/**
		 * Selection transition for one row click.
		 * @returns the next selection plus the row that becomes the range anchor.
		 */
		function toggleSelection(selected, sessionId) {
			const next = new Set(selected);
			if (next.has(sessionId)) next.delete(sessionId);
			else next.add(sessionId);
			return { selected: next, cursor: sessionId };
		}

		/** Inclusive Shift-range selection over the currently displayed order. */
		function applyRange(selected, order, fromId, toId, additive) {
			const from = order.indexOf(fromId);
			const to = order.indexOf(toId);
			if (from === -1 || to === -1) return new Set(selected);
			const next = additive ? new Set(selected) : new Set();
			const start = Math.min(from, to);
			const end = Math.max(from, to);
			for (let index = start; index <= end; index += 1) next.add(order[index]);
			return next;
		}

		/** Add every displayed row to the selection (select all). */
		function selectAll(selected, order) {
			const next = new Set(selected);
			for (const id of order) next.add(id);
			return next;
		}

		/** Symmetric difference of selection and displayed rows (invert). */
		function invertSelection(selected, order) {
			const next = new Set(selected);
			for (const id of order) {
				if (next.has(id)) next.delete(id);
				else next.add(id);
			}
			return next;
		}

		/** Drop ids that no longer exist in the list (after delete or host removal). */
		function pruneSelection(selected, items) {
			const alive = new Set((items ?? []).map((summary) => summary.sessionId));
			const next = new Set();
			for (const id of selected) if (alive.has(id)) next.add(id);
			return next;
		}

		/** One-line failure text for collected batch results. */
		function failureText(error) {
			if (error === null || error === undefined) return "unknown error";
			if (typeof error === "string") return error;
			const code = typeof error.code === "string" ? error.code : "";
			const message = typeof error.message === "string" ? error.message : String(error);
			return code === "" ? message : `${code}: ${message}`;
		}

		/** The bulleted per-id failure list both batch reports end with. */
		function failureList(failed) {
			return (Array.isArray(failed) ? failed : [])
				.map((entry) => {
					// A title is what the user recognises; the id is the fallback. The
					// `session-` prefix is common to every top-level id, so slicing the
					// raw id to eight characters used to show nothing but "session-".
					const rawId = String(entry?.id ?? "");
					const shortId = rawId.replace(/^session-/u, "").slice(0, 8);
					const label = typeof entry?.title === "string" && entry.title !== "" ? `「${entry.title}」` : shortId === "" ? rawId : shortId;
					return `• ${label}: ${String(entry?.reason ?? "")}`;
				})
				.join("\n");
		}

		/**
		 * The status key for one pin/archive outcome.
		 *
		 * `real` is what the workspace service's answer means: a batch that reached
		 * DSH's own archive is "archived", one that only touched this plugin's own
		 * mark has to say "hidden inside this plugin".
		 * @param kind - `pin`, `unpin`, `archive`, or `unarchive`.
		 * @param real - whether the workspace service performed it.
		 * @returns a dictionary key.
		 */
		function markStatusKey(kind, real) {
			if (kind === "pin") return "status.pinned";
			if (kind === "unpin") return "status.unpinned";
			if (kind === "archive") return real === true ? "status.archived" : "status.archivedLocal";
			return real === true ? "status.unarchived" : "status.unarchivedLocal";
		}

		/**
		 * The status line for a pin/archive batch, partial failures included.
		 *
		 * One place for the panel's copy, so a batch cannot be reported two
		 * different ways.
		 * @param t - the active translator.
		 * @param kind - `pin`, `unpin`, `archive`, or `unarchive`.
		 * @param result - `{ ok, failed, real }` from the batch action.
		 * @param n - how many ids were attempted.
		 * @returns `{ text, tone }` for the status seat.
		 */
		function markStatusText(t, kind, result, n) {
			const failed = Array.isArray(result?.failed) ? result.failed : [];
			if (failed.length > 0) {
				return {
					text: `${t("status.partial", { ok: result.ok, fail: failed.length })}\n${failureList(failed)}`,
					tone: "error"
				};
			}
			return { text: t(markStatusKey(kind, result?.real), { n }), tone: "info" };
		}

		/** Same ids in the same order — the cheap comparison the marks mirror uses. */
		function sameIds(left, right) {
			const a = Array.isArray(left) ? left : [];
			const b = Array.isArray(right) ? right : [];
			return a.length === b.length && a.every((id, index) => id === b[index]);
		}


		const internals = {
			inlineText,
			stamp,
			snapshotItems,
			normalizeSummary,
			makeTranslator,
			visibleRows,
			workspaceLabel,
			decodeWorkspaceDir,
			groupRows,
			flattenGroups,
			toggleSelection,
			applyRange,
			selectAll,
			invertSelection,
			pruneSelection,
			failureText,
			exportMarkdown,
			failureList,
			markStatusKey,
			markStatusText,
			sameIds,
		};
		if (typeof globalThis !== "undefined") globalThis.__DSH_SESSION_MULTISELECT__ = internals;

		// ---------------------------------------------------------------------
		// Diagnostics
		//
		// A plugin that hangs its entry in another plugin's DOM can fail in ways
		// the user cannot describe and the developer cannot see: whether the click
		// arrived at all, whether the panel rendered, what the error said. A small
		// bounded ring of notes in session storage answers exactly those, stays
		// scoped to the tab, and cannot grow without limit.
		// ---------------------------------------------------------------------

		/** Session-storage key holding the bounded diagnostic ring. */
		const DIAG_KEY = "dsh.session.multiselect.diag";
		/** How many notes the ring keeps. */
		const DIAG_LIMIT = 60;
		/**
		 * Bumped whenever this file changes. The ring records it, which is the
		 * only way to tell whether the running window actually reloaded a fix —
		 * a client bundle can be served fresh while the page keeps the old one.
		 */
		const BUILD = 33;

		/**
		 * Append one note to the diagnostic ring. Never throws, never blocks.
		 * @param event - short event name, e.g. `click`.
		 * @param detail - optional detail string.
		 */
		function note(event, detail) {
			try {
				if (typeof sessionStorage === "undefined") return;
				const raw = sessionStorage.getItem(DIAG_KEY);
				const parsed = raw === null ? [] : JSON.parse(raw);
				const trail = Array.isArray(parsed) ? parsed : [];
				const stamp = new Date().toISOString().slice(11, 23);
				trail.push(`${stamp} ${event}${detail === undefined ? "" : ` ${detail}`}`);
				sessionStorage.setItem(DIAG_KEY, JSON.stringify(trail.slice(-DIAG_LIMIT)));
			} catch {
				/* diagnostics must never break the feature they describe */
			}
		}

		/**
		 * Name a DOM node for the diagnostic ring: tag plus the first class.
		 * Class names are build-hashed, but they still identify WHICH element
		 * took a click — which is the whole question when a button is covered.
		 * @param node - node to describe.
		 * @returns a short label.
		 */
		function describeNode(node) {
			if (node === null || node === undefined) return "none";
			const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "?";
			const raw = typeof node.className === "string" ? node.className : "";
			const first = raw.split(/\s+/u)[0];
			return first === undefined || first === "" ? tag : `${tag}.${first}`;
		}

		/** Whether a viewport point falls inside an element's rendered box. */
		function pointInBox(element, x, y) {
			const box = measureBox(element);
			if (box === null || !Number.isFinite(x) || !Number.isFinite(y)) return false;
			return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
		}

		// ---------------------------------------------------------------------
		// Styles
		// ---------------------------------------------------------------------

		const STYLE_ID = "dsh-session-multiselect/styles";
		const CSS = `
.dsh-msel-root{display:flex;flex-direction:column;gap:10px;min-height:0}
.dsh-msel-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-msel-search{flex:1 1 200px;min-width:160px}
.dsh-msel-select{flex:1 1 150px;min-width:120px;height:28px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l4,#0000001a);background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff)));color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;padding:0 6px}
.dsh-msel-count{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-left:auto;white-space:nowrap}
.dsh-msel-list{border:0.5px solid var(--dsw-alias-border-l4,#0000001a);border-radius:12px;overflow:auto;max-height:min(46vh,420px);min-height:120px}
.dsh-msel-row{display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary,inherit);border-bottom:0.5px solid var(--dsw-alias-border-l4,#0000001a)}
.dsh-msel-row:last-child{border-bottom:none}
/* Workspace heading: sticky so the section keeps a name while its rows scroll. */
.dsh-msel-group{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;user-select:none;background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#f7f7f8)));border-bottom:0.5px solid var(--dsw-alias-border-l4,#0000001a);color:var(--dsw-alias-label-secondary)}
.dsh-msel-group:hover{color:var(--dsw-alias-label-primary,inherit)}
.dsh-msel-groupBox{flex:none;width:14px;height:14px;border-radius:4px;border:1.5px solid var(--dsw-alias-border-l4,#00000033);display:inline-flex;align-items:center;justify-content:center;color:transparent;font-size:10px;line-height:1}
.dsh-msel-group[data-complete="true"] .dsh-msel-groupBox{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff}
/* Full-path heading: when a long path cannot fit, the *end* of it (the folder
   the user names the workspace by) is the part worth keeping, so the overflow is
   clipped from the left. direction:rtl moves the clip edge; unicode-bidi:plaintext
   keeps the path itself laid out left-to-right. */
.dsh-msel-groupName{flex:1;min-width:0;font-size:12px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;unicode-bidi:plaintext;text-align:left}
.dsh-msel-groupCount{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-msel-row:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d)}
.dsh-msel-row[data-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,#0000000d)}
.dsh-msel-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px}
.dsh-msel-row[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,#0000000d)}
.dsh-msel-box{flex:none;width:16px;height:16px;border-radius:5px;border:1.5px solid var(--dsw-alias-border-l4,#00000033);display:inline-flex;align-items:center;justify-content:center;color:transparent;font-size:11px;line-height:1}
.dsh-msel-row[data-selected="true"] .dsh-msel-box{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff}
.dsh-msel-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.dsh-msel-title{font-size:13px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-msel-meta{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);min-width:0}
.dsh-msel-cwd{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.dsh-msel-tag{flex:none;font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l4,#0000001a);color:var(--dsw-alias-label-tertiary)}
.dsh-msel-empty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dsh-msel-actions{display:flex;flex-wrap:wrap;gap:6px}
.dsh-msel-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;min-height:0}
.dsh-msel-status:empty{display:none}
.dsh-msel-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsh-msel-status[data-tone="warning"]{color:var(--dsw-alias-label-secondary)}
.dsh-msel-confirm{border:0.5px solid var(--dsw-alias-state-error-primary,#d92d20);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dsh-msel-confirmText{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary,inherit)}
/* Armed delete: proof on the button itself that the click landed, so a
   confirmation the user has not scrolled to is not a dead end. The emphasis is
   this plugin's own class: the primitives' variant vocabulary changed in 0.10
   (solid became primary), and "delete" must stay red through that. */
.dsh-msel-actions button[data-armed="true"]{outline:2px solid var(--dsw-alias-state-error-primary,#d92d20);outline-offset:1px}
.dsh-msel-danger{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsh-msel-busy{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-msel-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:4px}
.dsh-msel-entry{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:2px;background:transparent;border:none;border-radius:50%;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dsh-msel-entry:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d);color:var(--dsw-alias-label-primary,inherit)}
.dsh-msel-entry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}
.dsh-msel-entryCount{font-size:10px;line-height:1}
/* 28px square: the box DSH gives its own header icons, so the row's buttons keep
   one rhythm. No margin or gap here — the distance to the magnifier is measured
   from the live row (see alignInlineHost) and set inline on the host. The
   app-region opt-out keeps a frameless shell from treating the click as a window
   drag; it is inert everywhere else. */
.dsh-msel-inline{corner-shape:round;cursor:pointer;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:none;border-radius:50%;color:var(--dsw-alias-label-secondary);padding:0;flex:none;-webkit-app-region:no-drag;user-select:none;-webkit-user-drag:none}
.dsh-msel-inline:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d);color:var(--dsw-alias-label-primary,inherit)}
.dsh-msel-inline:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}
/* While the panel is open the button stays lit, so the trigger and the dialog
   read as one control (and a click that lands is visible even if a dialog is
   slow to appear). */
.dsh-msel-inline[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover,#0000000d);color:var(--dsw-alias-label-primary,inherit)}
/* The bundle's own dialog, drawn only when the client seeds no primitives to
   draw it with (DSH 0.2 seeds React and static libraries only). Same tokens as
   the rest of the panel, so the two paths look like one plugin. */
.dsh-msel-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1,#00000059)}
.dsh-msel-modal{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:min(560px,100%);max-height:min(80vh,720px);padding:18px 20px;border-radius:16px;border:0.5px solid var(--dsw-alias-border-l4,#0000001a);background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#ffffff)));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 16px 48px #00000033}
.dsh-msel-modalHead{display:flex;align-items:center;gap:8px}
.dsh-msel-modalTitle{flex:1;min-width:0;font-size:15px;line-height:22px;font-weight:500}
.dsh-msel-modalClose{flex:none;width:28px;height:28px;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;line-height:1}
.dsh-msel-modalClose:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d);color:var(--dsw-alias-label-primary,inherit)}
.dsh-msel-modalDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-msel-modalBody{min-height:0;overflow:auto}
.dsh-msel-inputWrap{box-sizing:border-box;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l4,#0000001a);color:var(--dsw-alias-label-secondary)}
.dsh-msel-inputWrap:focus-within{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-msel-inputIcon{flex:none;display:inline-flex;align-items:center}
.dsh-msel-trashRow{display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l4,#0000001a)}
.dsh-msel-trashRow:last-child{border-bottom:none}
.dsh-msel-trashMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsh-msel-trashTitle{font-size:13px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-msel-trashSub{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
/* A long workspace path keeps its tail — the folder names the project. */
.dsh-msel-trashWorkspace{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;unicode-bidi:plaintext;text-align:left}
.dsh-msel-trashWhen{flex:none;white-space:nowrap}
.dsh-msel-trashRemaining{flex:none;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dsh-msel-trashAction{flex:none;display:inline-flex;align-items:center;gap:6px}
/* Titles of the conversations a delete will remove, under the confirmation copy. */
.dsh-msel-confirmList{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-msel-input{flex:1;min-width:0;border:none;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;outline:none}
`;

		// The dialog falls back to LocalModal/LocalButton/LocalInput (see `ui` and
		// `chromeSource` above) when the primitives are absent or renamed, so this
		// bundle renders on every supported build instead of refusing to load.

		/** Export names each icon has shipped under, newest first. */
		const ICON_NAMES = {
			search: ["IconSearchOutlineRegular", "IconSearchOutlineMedium", "IconSearchOutline16"],
			checklist: ["IconChecklistOutlineRegular", "IconChecklistOutlineMedium", "IconChecklistOutline14"],
			loading: ["IconLoadingOutlineRegular", "IconLoadingOutlineMedium", "IconLoadingOutline16"],
			pin: ["IconPinOutlineRegular", "IconPinOutlineMedium", "IconPinOutline"],
			check: ["IconCheckOutlineRegular", "IconCheckOutlineMedium", "IconCheckOutline"]
		};

		/**
		 * Copies of the shipped 16px artwork, path data included, so a primitives
		 * table that renames or drops its icons still leaves the plugin looking
		 * like DSH rather than like nothing at all.
		 */
		const ICON_ARTWORK = {
			search: [
				"M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z",
				"M10.2991 10.3933L14.7783 14.8725"
			],
			checklist: [
				"M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z",
				"M7.5 4.5H13.5",
				"M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z",
				"M7.5 11.5H13.5"
			],
			loading: [
				"M12.596 12.596C11.687 13.5049 10.5288 14.1239 9.26798 14.3747C8.00716 14.6255 6.70028 14.4968 5.51261 14.0048C4.32494 13.5129 3.30981 12.6798 2.59557 11.611C1.88134 10.5421 1.50008 9.2855 1.5 7.99998C1.50008 6.71446 1.88134 5.45783 2.59557 4.38898C3.30981 3.32013 4.32494 2.48707 5.51261 1.99513C6.70028 1.50319 8.00716 1.37447 9.26798 1.62524C10.5288 1.87602 11.687 2.49502 12.596 3.40398"
			],
			pin: [
				"M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z",
				"M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z"
			],
			check: [
				"M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4"
			]
		};

		/** One inline icon: the same box, stroke, and paths the primitives draw. */
		function fallbackIcon(artwork) {
			return (props) => jsx("svg", {
				width: props?.size ?? 16,
				height: props?.size ?? 16,
				viewBox: "0 0 16 16",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				strokeWidth: 1,
				"aria-hidden": "true",
				children: artwork.map((d) => jsx("path", { key: d, d, stroke: "currentColor" }))
			});
		}

		/**
		 * Resolve the three icons this bundle draws.
		 *
		 * @returns `{ icons, used }` — `icons` always has `search`, `checklist`,
		 * `loading`; `used` names what each one resolved to, for the diagnostic
		 * ring (a `fallback(...)` entry means DSH renamed its icons again).
		 */
		function resolveIcons() {
			const icons = {};
			const used = {};
			for (const key of Object.keys(ICON_ARTWORK)) {
				const found = (ICON_NAMES[key] ?? []).find((name) => isComponent(primitives[name]));
				icons[key] = found === undefined ? fallbackIcon(ICON_ARTWORK[key]) : primitives[found];
				used[key] = found ?? `fallback(${(ICON_NAMES[key] ?? [])[0] ?? key})`;
			}
			return { icons, used };
		}

		/** Accessible names the session-list search button ships with. */
		const SEARCH_LABELS = ["搜索会话", "Search sessions"];
		/** Placeholder the search input ships with (fallback locator). */
		const SEARCH_PLACEHOLDERS = ["搜索会话…", "搜索会话...", "Search conversations"];
		/** Marker attribute proving the inline host belongs to this plugin. */
		const HOST_ATTR = "data-dsh-msel-host";
		const HOST_VALUE = "session-multiselect";

		/**
		 * Find the search *control*: the flex row that holds the magnifier (and,
		 * when expanded, the input and clear button).
		 *
		 * This is the element to insert BEFORE. It is deliberately not the row's
		 * interior: the control is `width:100%` with `overflow:hidden`, so a
		 * button injected inside it squeezes the magnifier out of the clipped
		 * box and the icon vanishes.
		 * @param searchButton - the located search button.
		 * @returns the control wrapper, or null.
		 */
		function findSearchControl(searchButton) {
			const input = searchButton.parentElement?.parentElement?.querySelector?.("input") ?? null;
			if (input !== null && input.parentElement !== null) return input.parentElement;
			return searchButton.parentElement;
		}

		/** Install the stylesheet once per page (idempotent across HMR reloads). */
		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-multiselect";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ---------------------------------------------------------------------
		// Locale dictionaries
		// ---------------------------------------------------------------------

		const zh = {
			"entry.label": "多选对话",
			"entry.tip": "多选对话：批量删除 / 归档 / 置顶",
			"panel.title": "多选对话",
			"panel.description": "勾选多个对话后执行批量操作。",
			"panel.close": "关闭",
			"search.placeholder": "搜索标题或路径",
			"all.select": "全选",
			"all.invert": "反选",
			"all.clear": "清空",
			"option.archived": "显示归档",
			"trash.open": "回收站",
			"trash.back": "返回对话",
			"trash.title": "最近删除",
			"trash.empty": "回收站是空的：删除的对话会在这里保留 {n} 天",
			"trash.loading": "正在读取回收站…",
			"trash.loadFailed": "读取回收站失败：{reason}",
			"trash.deletedAt": "删除于 {time}",
			"trash.restore": "恢复",
			"trash.restored": "已恢复 {n} 个对话",
			"trash.restoreFailed": "恢复失败：{reason}",
			"trash.restoreUnknown": "恢复失败（没有返回原因）",
			"trash.purge": "永久删除",
			"trash.purgeAll": "清空回收站",
			"trash.purgeOneConfirm": "永久删除「{title}」？此操作不可恢复。",
			"trash.purgeAllConfirm": "永久删除回收站里的 {n} 个对话？此操作不可恢复。",
			"trash.purged": "已永久删除 {n} 个对话。",
			"trash.purgeFailed": "永久删除失败：{reason}",
			"trash.remaining": "还剩 {n} 天",
			"trash.searchPlaceholder": "搜索回收站…",
			"trash.filterWorkspace": "按工作区筛选",
			"trash.allWorkspaces": "全部工作区",
			"trash.restoreSelected": "恢复选中",
			"trash.purgeSelected": "永久删除选中",
			"trash.purgeBatchConfirm": "永久删除选中的 {n} 个对话？此操作不可恢复。",
			"confirm.deleteList": "将删除：",
			"confirm.probing": "正在检查打开状态…",
			"confirm.deleteRunning": "其中 {n} 个正在运行，不会被删除。",
			"confirm.deleteOpen": "其中 {n} 个仍被 DSH 打开：删除后列表里的行会在重启 DSH 后消失（文件已进回收站）。",
			"option.group": "按工作区分组",
			"group.count": "{n}/{m}",
			"group.noWorkspace": "未指定工作区",
			"group.toggle": "全选/取消全选该工作区",
			"count.selected": "已选 {n} / 共 {m}",
			"list.empty": "没有可选的对话。",
			"list.emptyFiltered": "没有匹配的对话。",
			"row.archived": "已归档",
			"row.running": "运行中",
			"row.open": "打开中",
			"group.mode": "分组",
			"group.workspace": "按工作区",
			"group.date": "按日期",
			"group.none": "不分组",
			"filter.by": "筛选",
			"filter.all": "全部",
			"filter.running": "运行中",
			"filter.pinned": "置顶",
			"date.today": "今天",
			"date.yesterday": "昨天",
			"date.week": "最近 7 天",
			"date.earlier": "更早",
			"export.copy": "复制清单",
			"export.copied": "已复制 {n} 行对话清单。",
			"export.failed": "复制失败：{reason}",
			"export.title": "标题",
			"export.workspace": "工作区",
			"export.updated": "更新时间",
			"export.status": "状态",
			"export.pinned": "置顶",
			"export.archived": "已归档",
			"export.running": "运行中",
			"row.pinned": "已置顶",
			"action.delete": "删除",
			"action.archive": "归档",
			"action.unarchive": "取消归档",
			"action.pin": "置顶",
			"action.unpin": "取消置顶",
			"hint": "提示：点击行切换勾选；Shift+点击按范围选择；点击工作区标题可整组勾选；↑/↓ 移动、空格勾选、Ctrl+A 全选、Delete 打开删除确认。",
			"confirm.delete": "将删除 {n} 个对话（移入回收站，7 天内可恢复）。",
			"confirm.yes": "确认删除",
			"confirm.purgeYes": "永久删除",
			"confirm.no": "取消",
			"busy.working": "正在执行…",
			"error.render": "面板渲染失败，已记录原因：{reason}",
			"status.deleted": "已删除 {n} 个对话。",
			"status.deletedOpen": "已删除 {ok} 个（其中 {open} 个仍被 DSH 打开：列表里的行会在重启 DSH 后消失；文件已在回收站，可恢复）。",
			"error.running": "会话正在运行，请先停止或关闭该对话再删除",
			"status.deleteFailed": "已删除 {ok} 个，{fail} 个失败：",
			"status.partial": "完成 {ok} 个，{fail} 个失败：",
			"status.archived": "已归档 {n} 个对话。",
			"status.unarchived": "已取消归档 {n} 个对话。",
			"status.archivedLocal": "已归档 {n} 个对话（仅本插件内隐藏）。",
			"status.unarchivedLocal": "已取消归档 {n} 个对话（仅本插件内）。",
			"status.pinned": "已置顶 {n} 个对话。",
			"status.unpinned": "已取消置顶 {n} 个对话。",
			"status.pinUnavailable": "这个 DSH 版本没有可用的置顶接口，未能置顶。",
			"status.nothing": "请先勾选至少一个对话。",
		};

		const en = {
			"entry.label": "Multi-select",
			"entry.tip": "Multi-select: batch delete / archive / pin",
			"panel.title": "Multi-select conversations",
			"panel.description": "Tick several conversations, then run one batch action.",
			"panel.close": "Close",
			"search.placeholder": "Search title or path",
			"all.select": "Select all",
			"all.invert": "Invert",
			"all.clear": "Clear",
			"option.archived": "Show archived",
			"trash.open": "Trash",
			"trash.back": "Back",
			"trash.title": "Recently deleted",
			"trash.empty": "Trash is empty: deleted conversations stay here for {n} days",
			"trash.loading": "Loading trash…",
			"trash.loadFailed": "Could not read trash: {reason}",
			"trash.deletedAt": "Deleted {time}",
			"trash.restore": "Restore",
			"trash.restored": "Restored {n} conversation(s)",
			"trash.restoreFailed": "Restore failed: {reason}",
			"trash.restoreUnknown": "Restore failed (no reason returned)",
			"trash.purge": "Delete permanently",
			"trash.purgeAll": "Empty trash",
			"trash.purgeOneConfirm": "Permanently delete \"{title}\"? This cannot be undone.",
			"trash.purgeAllConfirm": "Permanently delete {n} conversations in the trash? This cannot be undone.",
			"trash.purged": "Permanently deleted {n} conversation(s).",
			"trash.purgeFailed": "Permanent delete failed: {reason}",
			"trash.remaining": "{n} day(s) left",
			"trash.searchPlaceholder": "Search trash…",
			"trash.filterWorkspace": "Filter by workspace",
			"trash.allWorkspaces": "All workspaces",
			"trash.restoreSelected": "Restore selected",
			"trash.purgeSelected": "Delete selected",
			"trash.purgeBatchConfirm": "Permanently delete the {n} selected conversations? This cannot be undone.",
			"confirm.deleteList": "Deleting:",
			"confirm.probing": "Checking which conversations are open…",
			"confirm.deleteRunning": "{n} of them are running and will not be deleted.",
			"confirm.deleteOpen": "{n} are still open in DSH: those rows leave the list after a restart (their files are in the trash).",
			"option.group": "Group by workspace",
			"group.count": "{n}/{m}",
			"group.noWorkspace": "No workspace",
			"group.toggle": "Select or clear this whole workspace",
			"count.selected": "{n} of {m} selected",
			"list.empty": "No selectable conversations.",
			"list.emptyFiltered": "No conversation matches.",
			"row.archived": "Archived",
			"row.pinned": "Pinned",
			"row.running": "Running",
			"row.open": "Open",
			"group.mode": "Group",
			"group.workspace": "By workspace",
			"group.date": "By date",
			"group.none": "No grouping",
			"filter.by": "Filter",
			"filter.all": "All",
			"filter.running": "Running",
			"filter.pinned": "Pinned",
			"date.today": "Today",
			"date.yesterday": "Yesterday",
			"date.week": "Last 7 days",
			"date.earlier": "Earlier",
			"export.copy": "Copy list",
			"export.copied": "Copied {n} rows.",
			"export.failed": "Copy failed: {reason}",
			"export.title": "Title",
			"export.workspace": "Workspace",
			"export.updated": "Updated",
			"export.status": "Status",
			"export.pinned": "Pinned",
			"export.archived": "Archived",
			"export.running": "Running",
			"action.delete": "Delete",
			"action.archive": "Archive",
			"action.unarchive": "Unarchive",
			"action.pin": "Pin",
			"action.unpin": "Unpin",
			"hint": "Click a row to toggle; Shift+click selects a range; click a workspace heading to take the whole group; ↑/↓ move, Space toggles, Ctrl+A selects all, Delete opens the confirmation.",
			"confirm.delete": "Delete {n} conversation(s)? They move to the trash and stay restorable for 7 days.",
			"confirm.yes": "Delete",
			"confirm.purgeYes": "Delete permanently",
			"confirm.no": "Cancel",
			"busy.working": "Working…",
			"error.render": "The panel failed to render: {reason}",
			"status.deleted": "Deleted {n} conversation(s).",
			"status.deletedOpen": "Deleted {ok} ({open} still open in DSH: those rows leave the list after a restart; the files are in the trash and can be restored).",
			"error.running": "The conversation is running; stop or close it before deleting",
			"status.deleteFailed": "Deleted {ok}, {fail} failed: ",
			"status.partial": "Done {ok}, {fail} failed: ",
			"status.archived": "Archived {n} conversation(s).",
			"status.unarchived": "Unarchived {n} conversation(s).",
			"status.archivedLocal": "Archived {n} conversation(s) (hidden inside this plugin).",
			"status.unarchivedLocal": "Unarchived {n} conversation(s) (inside this plugin).",
			"status.pinned": "Pinned {n} conversation(s).",
			"status.unpinned": "Unpinned {n} conversation(s).",
			"status.pinUnavailable": "This DSH build exposes no pinning API, so nothing was pinned.",
			"status.nothing": "Select at least one conversation first.",
		};

		// Published for the tests: the dictionaries are the key-set source of truth
		// for the panel's copy, so a test can translate without the slot's `t`.
		internals.dicts = { zh, en };

		const NS = "sessionMultiselect";

		// ---------------------------------------------------------------------
		// Panel
		// ---------------------------------------------------------------------

		/** The multi-select panel body, rendered inside the primitives' Modal. */
		function MultiSelectPanel({ actions, hooks, t, icons, tip: _tip }) {
			const list = react.useSyncExternalStore(hooks.sessions.subscribe, hooks.sessions.getSnapshot);
			const state = react.useSyncExternalStore(hooks.store.subscribe, hooks.store.getSnapshot);
			// Pinned/archived membership comes from the workspace service when the
			// build has one, so the panel agrees with DSH's own list instead of
			// keeping a second opinion (see the marks mirror in apply).
			const marks = react.useSyncExternalStore(hooks.marks.subscribe, hooks.marks.getSnapshot);
			const [query, setQuery] = react.useState("");
			const [showArchived, setShowArchived] = react.useState(false);
			const [selected, setSelected] = react.useState(() => new Set());
			const [cursor, setCursor] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [confirming, setConfirming] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			const [view, setView] = react.useState("sessions");
			const [trash, setTrash] = react.useState({ status: "idle", entries: [], error: null, retentionDays: 7 });
			const [trashConfirm, setTrashConfirm] = react.useState(null);
			const [trashSelected, setTrashSelected] = react.useState(() => new Set());
			const [openIds, setOpenIds] = react.useState(() => new Set());
			const [deleteProbe, setDeleteProbe] = react.useState(null);
			const [activeId, setActiveId] = react.useState(null);
			const [trashQuery, setTrashQuery] = react.useState("");
			const [trashWorkspace, setTrashWorkspace] = react.useState("");
			/** Focused DOM node per row id, so arrow keys can move the browser focus. */
			const rowRefs = react.useRef(new Map());
			// The confirmation is painted just above the button row, at the bottom of
			// a dialog whose list can already fill the viewport. Without this the
			// click looks like it did nothing, because the box it revealed is below
			// the fold.
			const confirmRef = react.useRef(null);
			react.useEffect(() => {
				if (!confirming) return;
				const node = confirmRef.current;
				if (node !== null && typeof node?.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
			}, [confirming]);
			const filter = state?.filter === "running" || state?.filter === "pinned" ? state.filter : "all";
			const rows = react.useMemo(
				() => visibleRows(list, marks, query, showArchived, filter).filter((row) => hooks.isHidden?.(row.sessionId) !== true),
				[list, marks, query, showArchived, filter, hooks]
			);
			// Grouping reorders rows, so `order` — the list Shift+click and select-all
			// walk — must come from the grouped layout rather than from `rows`.
			// Three grouping modes; a stored pre-0.10 snapshot only carries the
			// boolean, so that is the fallback when groupMode is absent.
			const groupMode = state?.groupMode === "date" || state?.groupMode === "none" || state?.groupMode === "workspace"
				? state.groupMode
				: (state?.groupByWorkspace === false ? "none" : "workspace");
			const grouped = groupMode !== "none";
			const groups = react.useMemo(() => groupRows(rows, groupMode), [rows, groupMode]);
			const order = react.useMemo(() => flattenGroups(groups).map((row) => row.sessionId), [groups]);
			const items = snapshotItems(list);
			const itemsRef = react.useRef(items);
			itemsRef.current = items;
			// Recorded for bug reports: a click that opened the panel but never
			// painted is a different failure from one that never opened it.
			react.useEffect(() => { note("panel rendered", `rows=${String(rows.length)}`); }, []);

			// A deletion (or a host-side removal) can invalidate held ids.
			const aliveKey = items.map((item) => item.sessionId).join(",");
			react.useEffect(() => {
				setSelected((current) => {
					const next = pruneSelection(current, itemsRef.current);
					if (next.size === current.size) {
						let same = true;
						for (const id of current) if (!next.has(id)) same = false;
						if (same) return current;
					}
					return next;
				});
			}, [aliveKey]);

			// Ask the host which rows it still holds open. The delete route can only move
			// files, so those rows survive in DSH's list until the app restarts; the badge
			// says so before the user wonders why a deleted row is still there. One dry=1
			// probe per list change — it never mutates anything.
			react.useEffect(() => {
				const ids = items.map((item) => item.sessionId);
				if (ids.length === 0) {
					setOpenIds(new Set());
					return undefined;
				}
				let cancelled = false;
				void actions.probeOpenSessions(ids).then((result) => {
					if (!cancelled) setOpenIds(new Set(result.open));
				});
				return () => { cancelled = true; };
			}, [aliveKey, actions]);

			const report = react.useCallback((text, tone) => {
				setStatus(text === null || text === "" ? null : { text, tone: tone ?? "info" });
			}, []);

			const runBatch = react.useCallback(async (task) => {
				setBusy(true);
				setStatus(null);
				try {
					await task();
				} catch (error) {
					note("action error", failureText(error));
					report(failureText(error), "error");
				} finally {
					setBusy(false);
				}
			}, [report]);

			/** Read the restore list; the panel shows it in place of the session list. */
			const loadTrash = react.useCallback(async () => {
			  setTrash((current) => ({ ...current, status: "loading", error: null }));
			  try {
			    const result = await actions.listTrash();
			    if (result !== null && result.error !== undefined && result.error !== null) {
			      const reason = failureText(result.error);
			      note("trash list failed", reason);
			      setTrash((current) => ({ ...current, status: "error", entries: [], error: reason }));
			      return;
			    }
			    const retentionDays = typeof result?.retentionDays === "number" ? result.retentionDays : 7;
			    setTrash({ status: "ready", entries: Array.isArray(result?.entries) ? result.entries : [], error: null, retentionDays });
			    setTrashSelected((current) => {
				      if (current.size === 0) return current;
				      const alive = new Set((Array.isArray(result?.entries) ? result.entries : []).map((entry) => entry.id));
				      const next = new Set();
				      for (const id of current) if (alive.has(id)) next.add(id);
				      return next.size === current.size ? current : next;
			    });
			  } catch (error) {
			    const reason = failureText(error);
			    note("trash list failed", reason);
			    setTrash((current) => ({ ...current, status: "error", entries: [], error: reason }));
			  }
			}, [actions]);

			const openTrash = () => { setView("trash"); void loadTrash(); };
			const backToSessions = () => { setView("sessions"); };

			/** Restore one trashed conversation and refresh both lists. */
			const restoreTrashEntry = (id) => runBatch(async () => {
			  const result = await actions.restoreSessions([id]);
			  const failed = Array.isArray(result?.failed) ? result.failed : [];
			  if (failed.length > 0) {
			    report(t("trash.restoreFailed", { reason: String(failed[0]?.reason ?? t("trash.restoreUnknown")) }), "error");
			  } else {
			    report(t("trash.restored", { n: String(result?.ok ?? 0) }), "info");
			  }
			  await loadTrash();
			});

			/** Permanently drop one trashed conversation (the trash "delete"). */
			const purgeTrashEntry = (entry) => runBatch(async () => {
			  const result = await actions.purgeTrash([entry.id]);
			  if (result.ok === false) {
			    const reason = Array.isArray(result.failed) && result.failed.length > 0 ? String(result.failed[0]?.reason ?? t("trash.restoreUnknown")) : String(result.error ?? t("trash.restoreUnknown"));
			    report(t("trash.purgeFailed", { reason }), "error");
			  } else {
			    report(t("trash.purged", { n: String(result.purged ?? 1) }), "info");
			  }
			  setTrashConfirm(null);
			  await loadTrash();
			});

			/** Empty the whole trash. */
			const purgeAllTrash = () => runBatch(async () => {
			  const result = await actions.purgeAllTrash();
			  if (result.ok === false) report(t("trash.purgeFailed", { reason: String(result.error ?? t("trash.restoreUnknown")) }), "error");
			  else report(t("trash.purged", { n: String(result.purged ?? 0) }), "info");
			  setTrashConfirm(null);
			  await loadTrash();
			});

			/** Checked trash ids, the select-all toggle, and the two batch actions. */
			const trashSelectedIds = react.useMemo(() => trash.entries.map((entry) => entry.id).filter((id) => trashSelected.has(id)), [trash.entries, trashSelected]);
			/** Trash rows after the search box and the workspace filter. */
			const trashVisibleEntries = react.useMemo(() => {
				const needle = String(trashQuery).trim().toLowerCase();
				return trash.entries.filter((entry) => {
					if (trashWorkspace !== "" && entry.workspace !== trashWorkspace) return false;
					if (needle === "") return true;
					const title = typeof entry.title === "string" ? entry.title : "";
					const workspace = decodeWorkspaceDir(typeof entry.workspace === "string" ? entry.workspace : "");
					return `${title}\n${workspace}`.toLowerCase().includes(needle);
				});
			}, [trash.entries, trashQuery, trashWorkspace]);
			const trashVisibleIds = trashVisibleEntries.map((entry) => entry.id);
			/** Every workspace present in the trash, for the filter select. */
			const trashWorkspaces = react.useMemo(() => {
				const seen = new Map();
				for (const entry of trash.entries) {
					const raw = typeof entry.workspace === "string" ? entry.workspace : "";
					if (raw !== "" && !seen.has(raw)) seen.set(raw, decodeWorkspaceDir(raw));
				}
				return [...seen.entries()].map(([raw, label]) => ({ raw, label }));
			}, [trash.entries]);
			const allTrashSelected = trashVisibleIds.length > 0 && trashVisibleIds.every((id) => trashSelected.has(id));
			const toggleTrashSelected = (id) => {
				setTrashSelected((current) => {
					const next = new Set(current);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
			};
			const toggleAllTrash = () => {
				setTrashSelected((current) => {
					const next = new Set(current);
					if (allTrashSelected) for (const id of trashVisibleIds) next.delete(id);
					else for (const id of trashVisibleIds) next.add(id);
					return next;
				});
			};

			/** Restore every checked trashed conversation in one route call. */
			const restoreTrashBatch = () => runBatch(async () => {
				const ids = trashSelectedIds.slice();
				if (ids.length === 0) return;
				const result = await actions.restoreSessions(ids);
				const failed = Array.isArray(result?.failed) ? result.failed : [];
				if (failed.length > 0) {
					report(`${t("status.partial", { ok: result?.ok ?? 0, fail: failed.length })}\n${failureList(failed)}`, "error");
				} else {
					report(t("trash.restored", { n: String(result?.ok ?? ids.length) }), "info");
				}
				setTrashSelected(new Set());
				await loadTrash();
			});

			/** Permanently drop every checked trashed conversation. */
			const purgeTrashBatch = (ids) => runBatch(async () => {
				const result = await actions.purgeTrash(ids);
				if (result.ok === false) {
					const reason = Array.isArray(result.failed) && result.failed.length > 0 ? String(result.failed[0]?.reason ?? t("trash.restoreUnknown")) : String(result.error ?? t("trash.restoreUnknown"));
					report(t("trash.purgeFailed", { reason }), "error");
				} else {
					report(t("trash.purged", { n: String(result.purged ?? ids.length) }), "info");
				}
				setTrashConfirm(null);
				setTrashSelected(new Set());
				await loadTrash();
			});

			/** The one confirmation strip: delete in the session view, purge in the trash. */
			const renderConfirmBar = () => {
			  if (view === "trash") {
			    if (trashConfirm === null) return null;
			    return jsx("div", { ref: confirmRef, className: "dsh-msel-confirm", children: [
			      jsx("div", { className: "dsh-msel-confirmText", children: trashConfirm.kind === "all" ? t("trash.purgeAllConfirm", { n: String(trash.entries.length) }) : trashConfirm.kind === "batch" ? t("trash.purgeBatchConfirm", { n: String(trashConfirm.ids.length) }) : t("trash.purgeOneConfirm", { title: trashConfirm.title }) }),
			      jsx("div", { className: "dsh-msel-toolbar", children: [
			        jsx(ui.Button, { size: "sm", disabled: busy, className: "dsh-msel-danger", onClick: () => { if (trashConfirm.kind === "all") { purgeAllTrash(); } else if (trashConfirm.kind === "batch") { purgeTrashBatch(trashConfirm.ids); } else { purgeTrashEntry(trashConfirm.entry); } }, children: t("confirm.purgeYes") }),
			        jsx(ui.Button, { size: "sm", disabled: busy, onClick: () => { setTrashConfirm(null); }, children: t("confirm.no") })
			      ] })
			    ] });
			  }
			  if (!confirming) return null;
			  return jsx("div", { ref: confirmRef, className: "dsh-msel-confirm", children: [
			    jsx("div", { className: "dsh-msel-confirmText", children: t("confirm.delete", { n: count }) }),
			    selectedTitles.length === 0 ? null : jsx("div", { className: "dsh-msel-confirmList", children: selectedTitles.map((title, index) => jsx("div", { key: `sample:${String(index)}`, children: `• ${title}` })) }),
			    deleteProbe === null ? null : deleteProbe.status === "loading" ? jsx("div", { className: "dsh-msel-confirmList", children: t("confirm.probing") }) : jsx("div", { className: "dsh-msel-confirmList", children: [
				      deleteProbe.running > 0 ? jsx("div", { children: t("confirm.deleteRunning", { n: String(deleteProbe.running) }) }) : null,
				      deleteProbe.open - deleteProbe.running > 0 ? jsx("div", { children: t("confirm.deleteOpen", { n: String(deleteProbe.open - deleteProbe.running) }) }) : null
			    ] }),
			    jsx("div", { className: "dsh-msel-toolbar", children: [
			      jsx(ui.Button, {
			        size: "sm",
			        disabled: busy,
			        className: "dsh-msel-danger",
			        onClick: () => { void doDelete(); },
			        children: t("confirm.yes")
			      }),
			      jsx(ui.Button, { size: "sm", disabled: busy, onClick: () => { setConfirming(false);
				setDeleteProbe(null); }, children: t("confirm.no") })
			    ] })
			  ] });
			};

			const renderTrash = () => {
			  if (trash.status === "loading") return jsx("div", { className: "dsh-msel-list", children: jsx("div", { className: "dsh-msel-empty", children: t("trash.loading") }) });
			  if (trash.status === "error") return jsx("div", { className: "dsh-msel-list", children: jsx("div", { className: "dsh-msel-empty", children: t("trash.loadFailed", { reason: String(trash.error ?? "") }) }) });
			  if (trash.entries.length === 0) return jsx("div", { className: "dsh-msel-list", children: jsx("div", { className: "dsh-msel-empty", children: t("trash.empty", { n: String(trash.retentionDays ?? 7) }) }) });
			  if (trashVisibleEntries.length === 0) return jsx("div", { className: "dsh-msel-list", children: jsx("div", { className: "dsh-msel-empty", children: t("list.emptyFiltered") }) });
			  return jsx("div", { className: "dsh-msel-list", role: "list", "aria-label": t("trash.title"), children: trashVisibleEntries.map((entry) => {
			    // Two lines: the title gets the full width (it is the name the user
			    // recognises), the workspace and deletion time sit underneath. Sharing
			    // one line made the title collapse to nothing whenever the encoded
			    // workspace name was long — which is every name.
			    const title = entry.title === "" || entry.title === undefined ? entry.id : entry.title;
			    const rawWorkspace = typeof entry.workspace === "string" ? entry.workspace : "";
			    const workspaceText = decodeWorkspaceDir(rawWorkspace);
			    const retentionDays = typeof trash.retentionDays === "number" ? trash.retentionDays : 7;
			    const remaining = typeof entry.deletedAt === "number" ? Math.max(0, Math.ceil((entry.deletedAt + (retentionDays * 86400000) - Date.now()) / 86400000)) : null;
			    const selectedEntry = trashSelected.has(entry.id);
			    return jsx("div", {
			      key: `trash:${String(entry.entry ?? entry.id)}`,
			      className: "dsh-msel-trashRow dsh-msel-row",
			      role: "option",
			      tabIndex: activeId === entry.id || (activeId === null && trashVisibleIds[0] === entry.id) ? 0 : -1,
			      "aria-selected": selectedEntry,
			      "data-selected": selectedEntry ? "true" : "false",
			      "data-active": activeId === entry.id ? "true" : "false",
			      ref: (node) => { if (node === null || node === undefined) rowRefs.current.delete(entry.id); else rowRefs.current.set(entry.id, node); },
			      onClick: () => { toggleTrashSelected(entry.id); },
			      onFocus: () => { setActiveId(entry.id); },
			      onKeyDown: (event) => { rowKeyboard(event, entry.id, () => { toggleTrashSelected(entry.id); }); },
			      children: [
			        jsx("span", { className: "dsh-msel-box", "aria-hidden": "true", children: "✓" }),
			        jsx("div", { className: "dsh-msel-trashMain", children: [
			          jsx("span", { className: "dsh-msel-trashTitle", title, children: title }),
			          jsx("span", { className: "dsh-msel-trashSub", children: [
			            workspaceText === "" ? null : jsx("span", { className: "dsh-msel-trashWorkspace", title: workspaceText, children: workspaceText }),
			            jsx("span", { className: "dsh-msel-trashWhen", children: t("trash.deletedAt", { time: stamp(entry.deletedAt) }) }),
			            remaining === null ? null : jsx("span", { className: "dsh-msel-trashRemaining", children: t("trash.remaining", { n: String(remaining) }) })
			          ] })
			        ] }),
			        jsx("span", { className: "dsh-msel-trashAction", children: [
			          jsx(ui.Button, { size: "sm", disabled: busy, onClick: (event) => { event?.stopPropagation?.(); restoreTrashEntry(entry.id); }, children: t("trash.restore") }),
			          jsx(ui.Button, { size: "sm", disabled: busy, className: "dsh-msel-danger", onClick: (event) => { event?.stopPropagation?.(); setTrashConfirm({ kind: "one", entry, title }); }, children: t("trash.purge") })
			        ] })
			      ]
			    }, `trash:${String(entry.entry ?? entry.id)}`);
			  }) });
			};

			const selectedIds = react.useMemo(() => order.filter((id) => selected.has(id)), [order, selected]);
			const count = selectedIds.length;
			const allRowsSelected = order.length > 0 && order.every((id) => selected.has(id));

			const onRowClick = (event, sessionId) => {
				if (event.shiftKey && cursor !== null && cursor !== sessionId) {
					setSelected((current) => applyRange(current, order, cursor, sessionId, event.ctrlKey || event.metaKey));
					return;
				}
				const next = toggleSelection(selected, sessionId);
				setSelected(next.selected);
				setCursor(next.cursor);
			};

			/**
			 * Flip exactly one workspace's rows.
			 *
			 * This is the reason grouping pays for itself: "the twelve conversations
			 * from that project" is one click, where the flat list needs twelve.
			 */
			const onGroupClick = (group) => {
				const ids = group.rows.map((row) => row.sessionId);
				if (ids.length === 0) return;
				setSelected((current) => {
					const all = ids.every((id) => current.has(id));
					const next = new Set(current);
					for (const id of ids) {
						if (all) next.delete(id);
						else next.add(id);
					}
					return next;
				});
				setCursor(ids[ids.length - 1]);
			};

			/** Every batch action funnels through here so the empty guard is uniform. */
			const guard = (task) => () => {
				if (count === 0) {
					note("action empty", "no rows selected");
					report(t("status.nothing"), "warning");
					return;
				}
				const ids = selectedIds.slice();
				void runBatch(() => task(ids));
			};

			/** Arm the delete confirmation and pre-check what will refuse or linger. */
			const armDelete = () => {
				const ids = selectedIds.slice();
				const running = ids.filter((id) => rows.find((row) => row.sessionId === id)?.running === true).length;
				setConfirming(true);
				setDeleteProbe({ status: "loading", running, open: running });
				if (ids.length === 0) {
					setDeleteProbe({ status: "ready", running: 0, open: 0 });
					return;
				}
				void actions.probeOpenSessions(ids).then((result) => {
					setDeleteProbe({ status: "ready", running, open: result.open.size });
				});
			};

			/** Arrow keys walk the visible rows; the focused row owns Space/Enter. */
			const moveActive = (delta) => {
				const ids = view === "trash" ? trashVisibleIds : order;
				if (ids.length === 0) return;
				const at = activeId === null ? -1 : ids.indexOf(activeId);
				const nextId = ids[Math.max(0, Math.min(ids.length - 1, at + delta))];
				setActiveId(nextId);
				if (view !== "trash") setCursor(nextId);
				const node = rowRefs.current.get(nextId);
				if (node !== null && node !== undefined && typeof node.focus === "function") node.focus();
				if (node !== null && node !== undefined && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
			};
			/** Panel-level shortcuts: Ctrl/Cmd+A select-all, Delete opens the confirmation. */
			const onPanelKeyDown = (event) => {
				if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "a") {
					event.preventDefault();
					if (view === "trash") toggleAllTrash();
					else setSelected((current) => selectAll(current, order));
					return;
				}
				if (event.key === "Delete" && view !== "trash" && count > 0) {
					event.preventDefault();
					armDelete();
				}
			};
			/** Copy the visible list as Markdown, for a bug report or a hand-off. */
			const copyList = () => {
				const textValue = exportMarkdown(rows, t);
				const done = () => { report(t("export.copied", { n: String(rows.length) }), "info"); };
				const fail = (error) => { report(t("export.failed", { reason: failureText(error) }), "error"); };
				try {
					if (typeof navigator !== "undefined" && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
						void navigator.clipboard.writeText(textValue).then(done, fail);
						return;
					}
					fail(new Error("clipboard unavailable"));
				} catch (error) {
					fail(error);
				}
			};

			/** Shared row keys: Space/Enter toggle, arrows move the focus. */
			const rowKeyboard = (event, id, toggle) => {
				if (event.key === " " || event.key === "Enter") {
					event.preventDefault();
					setActiveId(id);
					toggle();
					return;
				}
				if (event.key === "ArrowDown") { event.preventDefault(); setActiveId(id); moveActive(1); return; }
				if (event.key === "ArrowUp") { event.preventDefault(); setActiveId(id); moveActive(-1); return; }
				if (event.key === "Home") { event.preventDefault(); moveActive(-10000); return; }
				if (event.key === "End") { event.preventDefault(); moveActive(10000); }
			};

			const doDelete = guard(async (ids) => {
				note("delete start", `n=${String(ids.length)}`);
				const result = await actions.deleteSessions(ids);
				note("delete done", `ok=${String(result.ok)} failed=${String(result.failed.length)}${result.failed.length === 0 ? "" : ` ${result.failed.map((entry) => entry.reason).join(" | ")}`}`);
				setSelected(new Set());
				setConfirming(false);
				if (result.failed.length > 0) report(`${t("status.deleteFailed", { ok: result.ok, fail: result.failed.length })}\n${failureList(result.failed)}`, "error");
				else if (result.open > 0) report(t("status.deletedOpen", { ok: result.ok, open: result.open }), "info");
				else report(t("status.deleted", { n: result.ok }), "info");
				setDeleteProbe(null);
			});

			/**
			 * Report one pin/archive batch the same way for both directions.
			 *
			 * A run that reached the workspace service says so plainly; one that
			 * only touched this plugin's own marks has to admit that, because
			 * "archived" and "hidden inside this plugin" are different promises.
			 * Per-id refusals (DSH refuses to archive a session that is still
			 * active) are listed rather than swallowed.
			 */
			const reportMarkOutcome = (kind, result, n) => {
				const outcome = markStatusText(t, kind, result, n);
				report(outcome.text, outcome.tone);
			};

			/**
			 * Archive or restore the selection, depending on what it already is.
			 *
			 * The panel shows one archive button, so its direction is decided by the
			 * selection: all-archived means the user is looking at archived rows and
			 * wants them back, anything else means they want them out of the way.
			 */
			const toggleArchive = guard(async (ids) => {
				const archiving = !ids.every((id) => archivedNow.has(id));
				const result = await actions.setArchived(ids, archiving);
				reportMarkOutcome(archiving ? "archive" : "unarchive", result, ids.length);
			});

			/**
			 * Pin or unpin the selection — one button, both directions, for the same
			 * reason the archive button has both: three actions are all the room this
			 * row has, and an unpin with no button would strand every pinned row.
			 */
			const togglePin = guard(async (ids) => {
				const pinning = !ids.every((id) => pinnedNow.has(id));
				const result = await actions.setPinned(ids, pinning);
				if (result.real !== true) {
					note("pin unavailable", "no workspaces service");
					report(t("status.pinUnavailable"), "error");
					return;
				}
				reportMarkOutcome(pinning ? "pin" : "unpin", result, ids.length);
			});

			const disabled = busy || count === 0;
			// Whether a button reads as "归档" or "取消归档" follows the selection,
			// not the list: it is the same state toggle the button performs.
			const archivedNow = new Set(marks?.archivedIds ?? []);
			const pinnedNow = new Set(marks?.pinnedIds ?? []);
			const allSelectedArchived = count > 0 && selectedIds.every((id) => archivedNow.has(id));
			const allSelectedPinned = count > 0 && selectedIds.every((id) => pinnedNow.has(id));
			const actionButton = (label, onClick, variant) => jsx(ui.Button, {
				size: "sm",
				variant: variant ?? "ghost",
				disabled,
				onClick,
				children: label
			}, label);

			/** One selectable row. Shared by the grouped and the flat list. */
			const renderRow = (row) => {
				const isSelected = selected.has(row.sessionId);
				return jsx("div", {
					key: row.sessionId,
					className: "dsh-msel-row",
					role: "option",
					tabIndex: activeId === row.sessionId || (activeId === null && order[0] === row.sessionId) ? 0 : -1,
					"aria-selected": isSelected,
					"data-selected": isSelected ? "true" : "false",
					"data-active": activeId === row.sessionId ? "true" : "false",
					ref: (node) => { if (node === null || node === undefined) rowRefs.current.delete(row.sessionId); else rowRefs.current.set(row.sessionId, node); },
					onFocus: () => { setActiveId(row.sessionId); },
					onClick: (event) => { setActiveId(row.sessionId); onRowClick(event, row.sessionId); },
					onKeyDown: (event) => { rowKeyboard(event, row.sessionId, () => { onRowClick(event, row.sessionId); }); },
					children: [
						jsx("span", { className: "dsh-msel-box", "aria-hidden": "true", children: "✓" }),
						jsx("span", { className: "dsh-msel-main", children: [
							jsx("span", { className: "dsh-msel-title", children: row.title === "" ? row.sessionId.slice(0, 8) : row.title }),
							jsx("span", { className: "dsh-msel-meta", children: [
								row.pinned ? jsx("span", { className: "dsh-msel-tag", children: t("row.pinned") }) : null,
								row.archived ? jsx("span", { className: "dsh-msel-tag", children: t("row.archived") }) : null,
								row.running ? jsx("span", { className: "dsh-msel-tag", children: t("row.running") }) : null,
								!row.running && openIds.has(row.sessionId) ? jsx("span", { className: "dsh-msel-tag", children: t("row.open") }) : null,
								// The heading above already names the workspace, so the
								// per-row path would only repeat it.
								grouped || row.cwd === "" ? null : jsx("span", { className: "dsh-msel-cwd", children: row.cwd }),
								jsx("span", { children: stamp(row.updatedAt) })
							] })
						] })
					]
				}, row.sessionId);
			};

			/** The heading that names one workspace and selects all of it. */
			const renderGroup = (group) => {
				const ids = group.rows.map((row) => row.sessionId);
				const chosen = ids.filter((id) => selected.has(id)).length;
				const all = ids.length > 0 && chosen === ids.length;
				// The heading carries the whole path: two workspaces can share a last
				// segment, and the full path is what the user recognises. Date groups
				// carry an i18n key instead of a path.
				const name = group.kind === "date" ? t(group.label) : group.path === "" ? t("group.noWorkspace") : group.path;
				const short = group.kind === "date" ? name : group.label === "" ? t("group.noWorkspace") : group.label;
				return jsx("div", {
					key: `group:${group.key}`,
					className: "dsh-msel-group",
					"data-workspace": group.path,
					"data-complete": all ? "true" : "false",
					title: name,
					onClick: () => { onGroupClick(group); },
					children: [
						jsx("span", {
							className: "dsh-msel-groupBox",
							role: "checkbox",
							tabIndex: 0,
							"aria-checked": all,
							"aria-label": `${t("group.toggle")}: ${short}`,
							onKeyDown: (event) => {
								if (event.key === " " || event.key === "Enter") {
									event.preventDefault();
									onGroupClick(group);
								}
							},
							children: all ? "✓" : chosen === 0 ? "" : "–"
						}),
						jsx("span", { className: "dsh-msel-groupName", children: name }),
						jsx("span", { className: "dsh-msel-groupCount", children: t("group.count", { n: chosen, m: ids.length }) })
					]
				}, `group:${group.key}`);
			};

			const selectedTitles = react.useMemo(() => {
				const titles = new Map(rows.map((row) => [row.sessionId, row.title]));
				return selectedIds.slice(0, 3).map((id) => titles.get(id)).filter((title) => typeof title === "string" && title !== "");
			}, [rows, selectedIds]);

			return jsx("div", { className: "dsh-msel-root", onKeyDown: onPanelKeyDown, children: [
				jsx("div", { className: "dsh-msel-toolbar", children: view === "trash" ? [
					jsx("span", { className: "dsh-msel-count", children: t("trash.title") }),
					jsx(ui.Input, {
						className: "dsh-msel-search",
						icon: jsx(icons.search, {}),
						placeholder: t("trash.searchPlaceholder"),
						"aria-label": t("trash.searchPlaceholder"),
						value: trashQuery,
						onChange: (event) => { setTrashQuery(event.target.value); }
					}),
					jsx("select", {
						className: "dsh-msel-select",
						"aria-label": t("trash.filterWorkspace"),
						title: t("trash.filterWorkspace"),
						value: trashWorkspace,
						onChange: (event) => { setTrashWorkspace(event.target.value); },
						children: [
							jsx("option", { value: "", children: t("trash.allWorkspaces") }),
							...trashWorkspaces.map((workspace) => jsx("option", { key: workspace.raw, value: workspace.raw, children: workspace.label }))
						]
					}),
					jsx(ui.Button, { size: "sm", disabled: busy || trashVisibleIds.length === 0, onClick: toggleAllTrash, children: allTrashSelected ? t("all.clear") : t("all.select") }),
					jsx("span", { className: "dsh-msel-count", children: t("count.selected", { n: trashSelectedIds.length, m: trashVisibleIds.length }) }),
					jsx(ui.Button, { size: "sm", disabled: busy || trash.entries.length === 0, className: "dsh-msel-danger", onClick: () => { setTrashConfirm({ kind: "all" }); }, children: t("trash.purgeAll") }),
					jsx(ui.Button, { size: "sm", onClick: backToSessions, children: t("trash.back") })
				] : [
					jsx(ui.Input, {
						className: "dsh-msel-search",
						icon: jsx(icons.search, {}),
						placeholder: t("search.placeholder"),
						"aria-label": t("search.placeholder"),
						value: query,
						onChange: (event) => { setQuery(event.target.value); }
					}),
					jsx(ui.Button, {
						size: "sm",
						disabled: order.length === 0,
						onClick: () => { setSelected((current) => (allRowsSelected ? new Set() : selectAll(current, order))); },
						children: allRowsSelected ? t("all.clear") : t("all.select")
					}),
					jsx(ui.Button, {
						size: "sm",
						disabled: order.length === 0,
						onClick: () => { setSelected((current) => invertSelection(current, order)); },
						children: t("all.invert")
					}),
					jsx("select", {
						className: "dsh-msel-select",
						"aria-label": t("group.mode"),
						title: t("group.mode"),
						value: groupMode,
						onChange: (event) => { hooks.store.actions.setGroupMode(event.target.value); },
						children: [
							jsx("option", { value: "workspace", children: t("group.workspace") }),
							jsx("option", { value: "date", children: t("group.date") }),
							jsx("option", { value: "none", children: t("group.none") })
						]
					}),
					jsx("label", { className: "dsh-msel-hint", children: [
						jsx("input", {
							type: "checkbox",
							checked: showArchived,
							onChange: (event) => { setShowArchived(event.target.checked); }
						}),
						t("option.archived")
					] }),
					jsx("select", {
						className: "dsh-msel-select",
						"aria-label": t("filter.by"),
						title: t("filter.by"),
						value: filter,
						onChange: (event) => { hooks.store.actions.setFilter(event.target.value); },
						children: [
							jsx("option", { value: "all", children: t("filter.all") }),
							jsx("option", { value: "running", children: t("filter.running") }),
							jsx("option", { value: "pinned", children: t("filter.pinned") })
						]
					}),
					jsx("span", { className: "dsh-msel-count", children: t("count.selected", { n: count, m: order.length }) }),
					jsx(ui.Button, { size: "sm", onClick: openTrash, children: t("trash.open") }),
				] }),
				view === "trash" ? renderTrash() : jsx("div", {
					className: "dsh-msel-list",
					role: "listbox",
					"aria-busy": busy ? "true" : "false",
					"aria-multiselectable": "true",
					"aria-label": t("panel.title"),
					children: rows.length === 0
						? jsx("div", { className: "dsh-msel-empty", children: String(query).trim() === "" ? t("list.empty") : t("list.emptyFiltered") })
						: groups.flatMap((group) => (grouped ? [renderGroup(group), ...group.rows.map(renderRow)] : group.rows.map(renderRow)))
				}),
				renderConfirmBar(),
				jsx("div", { className: "dsh-msel-actions", children: view === "trash" ? [
					jsx(ui.Button, { size: "sm", disabled: busy || trashSelectedIds.length === 0, onClick: () => { void restoreTrashBatch(); }, children: t("trash.restoreSelected") }),
					jsx(ui.Button, { size: "sm", disabled: busy || trashSelectedIds.length === 0, className: "dsh-msel-danger", onClick: () => { setTrashConfirm({ kind: "batch", ids: trashSelectedIds.slice() }); }, children: t("trash.purgeSelected") })
				] : [
					// Armed state: the button itself shows that the click landed, so a
					// confirmation the user has not scrolled to is still not a dead end.
					// The emphasis is this plugin's own class rather than a Button
					// variant: the primitives renamed theirs (solid became primary)
					// and a destructive action must not lose its colour to that.
					jsx(ui.Button, {
						size: "sm",
						disabled,
						className: "dsh-msel-danger",
						"data-armed": confirming ? "true" : "false",
						onClick: () => { armDelete(); },
						children: t("action.delete")
					}),
					// One archive button, both directions: the row carries three
					// actions, so "取消归档" cannot be a fourth — without the toggle,
					// unarchiving would have no route in the UI at all.
					actionButton(allSelectedArchived ? t("action.unarchive") : t("action.archive"), () => { toggleArchive(); }),
					// Pinning works the same way and for the same reason. It goes
					// through the workspace service, so DSH's own list moves the row
					// into its pinned group — the button is not a private mark.
					actionButton(allSelectedPinned ? t("action.unpin") : t("action.pin"), () => { togglePin(); }),
					// Copy is about the visible list, not the selection: no count gate here.
					jsx(ui.Button, { size: "sm", variant: "ghost", disabled: busy || rows.length === 0, onClick: () => { copyList(); }, children: t("export.copy") })
				] }),
				busy ? jsx("div", { className: "dsh-msel-busy", children: [jsx(icons.loading, {}), t("busy.working")] }) : null,
				jsx("div", { className: "dsh-msel-status", role: "status", "aria-live": "polite", "data-tone": status === null ? "info" : status.tone, children: status === null ? "" : status.text }),
				jsx("div", { className: "dsh-msel-hint", children: t("hint") })
			] });
		}


		/**
		 * Keep a crash inside the panel visible.
		 *
		 * Without a boundary React unmounts the whole tree on an error — including
		 * the button that opened the dialog and the state that said it was open —
		 * so the user's click would look like it did nothing at all. Here the
		 * dialog stays and the reason is on screen.
		 */
		class PanelBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error) {
				note("panel error", failureText(error));
			}
			render() {
				const error = this.state.error;
				if (error === null) return this.props.children;
				return jsx("div", {
					className: "dsh-msel-status",
					"data-tone": "error",
					children: this.props.format(failureText(error))
				});
			}
		}

		// ---------------------------------------------------------------------
		// Session-list header injection
		//
		// The user asked for the entry next to the session list's search icon.
		// That toolbar belongs to `dsh-client-ui-workspace`, which declares no
		// header slot, so the only way there is a DOM insertion. Everything below
		// is written so that failure is harmless: the footer registration stays
		// the real mount point, and the inline button is a second view of the
		// same component; if the target never appears, the footer button remains.
		// ---------------------------------------------------------------------

		/**
		 * Locate the session list's search button. Class names are hashed per
		 * build, so matching goes by accessible name first (stable, and both
		 * shipped locales are covered), then by the stable `.bhn1Oq_` prefix as
		 * a structural fallback.
		 * @returns the real search button, or null.
		 */
		function findSearchButton() {
			if (typeof document === "undefined") return null;
			for (const label of SEARCH_LABELS) {
				const byLabel = document.querySelector(`button[aria-label=${JSON.stringify(label)}]`);
				if (byLabel !== null) return byLabel;
			}
			const byClass = document.querySelector('button[class*="_searchButton"]');
			if (byClass !== null) return byClass;
			// Last resort: the input's placeholder leads to the same control, and
			// its icon is the button sitting beside it.
			for (const placeholder of SEARCH_PLACEHOLDERS) {
				const input = document.querySelector(`input[placeholder=${JSON.stringify(placeholder)}]`);
				const sibling = input?.parentElement?.querySelector?.("button") ?? null;
				if (sibling !== null) return sibling;
			}
			return null;
		}

		/**
		 * Resolve the layout anchors for the inline button.
		 *
		 * `control` is the search control (the flex row holding the magnifier and
		 * the input); `row` is the header line that control sits on. The button is
		 * inserted into `row` as a sibling of `control`, which is what puts it
		 * immediately left of the magnifier without entering the control's
		 * `overflow:hidden` interior.
		 * @param searchButton - the located search button.
		 * @returns the anchors, or null when the tree is not shaped as expected.
		 */
		function findSearchParts(searchButton) {
			const control = findSearchControl(searchButton);
			if (control === null || control.parentElement === null) return null;
			return { control, row: control.parentElement };
		}

		/** The host wrapper this bundle owns, when one is currently attached. */
		function existingHost() {
			if (typeof document === "undefined") return null;
			// The selector matches on the marker attribute AND its value, so a
			// stale host from a previous plugin instance is still recognised.
			const host = document.querySelector(`[${HOST_ATTR}=${JSON.stringify(HOST_VALUE)}]`);
			return host === null ? null : host;
		}


		/**
		 * Property this plugin stamps on a native event it has already acted on.
		 *
		 * The entry button is wired twice on purpose — a document-level capture
		 * listener and React's own `onClick`. Opening twice is idempotent, but the
		 * stamp keeps the ring honest about which path acted. It travels with the
		 * event, so the backup can see that the primary one already ran.
		 */
		const ENTRY_MARK = "__dshMselEntryHandled";


		/**
		 * Stamp a native event as already acted on.
		 *
		 * Fails quietly: an event object that refuses the property (a frozen
		 * synthetic) simply loses the de-duplication, and the gesture is handled
		 * twice — which is the behaviour that existed before the stamp.
		 * @param event - the event to stamp.
		 * @returns true when this event was already stamped.
		 */
		function entryHandled(event) {
			if (event === null || event === undefined || typeof event !== "object") return false;
			if (event[ENTRY_MARK] === true) return true;
			try {
				event[ENTRY_MARK] = true;
			} catch {
				/* not stampable: the gesture may be counted twice */
			}
			return false;
		}


		/** Spacing used when the live row cannot be measured (this build's value). */
		const INLINE_GAP_FALLBACK = 4;

		/**
		 * Rendered box of an element, or null when it cannot be measured.
		 *
		 * Every geometry helper below tolerates a missing layout engine: the same
		 * code runs under `node --test` against a DOM stub, where the honest
		 * answer is "not measurable" and the stylesheet's values stand.
		 * @param element - element to measure.
		 * @returns the client rect, or null.
		 */
		function measureBox(element) {
			if (element === null || element === undefined) return null;
			if (typeof element.getBoundingClientRect !== "function") return null;
			try {
				const box = element.getBoundingClientRect();
				if (box === null || !Number.isFinite(box.left) || !Number.isFinite(box.right)) return null;
				return box;
			} catch {
				return null;
			}
		}

		/** Computed style of an element, or null when the browser cannot supply one. */
		function computedStyle(element) {
			if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return null;
			try {
				return window.getComputedStyle(element);
			} catch {
				return null;
			}
		}

		/**
		 * The spacing DSH's own header icons use, in px.
		 *
		 * Read from the rendered row — the magnifier to the next button — rather
		 * than assumed, because that distance is what the eye compares the
		 * injected button against. A theme that changes the row's gap is followed
		 * automatically; the computed `column-gap`, then this build's 4px, are the
		 * fallbacks.
		 * @param row - the search control's line.
		 * @param searchButton - the magnifier.
		 * @returns spacing in px.
		 */
		function readIconGap(row, searchButton) {
			// One level up from the search control is the line that lays the icons
			// out, so the spacing between ITS items is the spacing to copy. A button
			// inside the search control (the clear affordance of an expanded search)
			// is simply further away and loses to the nearest one.
			const line = row.parentElement ?? row;
			const anchor = measureBox(searchButton);
			if (anchor !== null) {
				let nearest = null;
				const candidates = typeof line.querySelectorAll === "function" ? line.querySelectorAll("button") : [];
				for (const candidate of candidates) {
					if (candidate === searchButton) continue;
					const box = measureBox(candidate);
					if (box === null || box.width <= 0) continue;
					// Skip this plugin's own button (it sits to the left of the
					// magnifier) and any button that is not on this line.
					if (box.left < anchor.right - 0.5) continue;
					if (box.bottom <= anchor.top || box.top >= anchor.bottom) continue;
					const distance = box.left - anchor.right;
					if (nearest === null || distance < nearest) nearest = distance;
				}
				if (nearest !== null) return nearest;
			}
			const computed = computedStyle(line) ?? computedStyle(row);
			const declared = Number.parseFloat(computed?.columnGap || computed?.gap || "");
			return Number.isFinite(declared) && declared >= 0 ? declared : INLINE_GAP_FALLBACK;
		}

		/**
		 * How far the rendered spacing is from the target, in px.
		 *
		 * A host whose React tree has not been committed yet reports an all-zero
		 * box; that is reported as "not measurable" so the caller waits a frame
		 * instead of applying a nonsense correction.
		 * @returns px error (positive = too far from the magnifier), or null.
		 */
		function measureGapError(host, searchButton, gap) {
			const hostBox = measureBox(host);
			const anchor = measureBox(searchButton);
			if (hostBox === null || anchor === null) return null;
			if (!Number.isFinite(hostBox.width) || hostBox.width <= 0) return null;
			return anchor.left - hostBox.right - gap;
		}

		/**
		 * Nudge the host until its rendered spacing matches the target.
		 * @returns true once the spacing was measured (settled, or unmeasurable
		 * and therefore left alone).
		 */
		function verifyIconGap(host, searchButton, gap) {
			for (let pass = 0; pass < 2; pass += 1) {
				const error = measureGapError(host, searchButton, gap);
				if (error === null) return false;
				if (Math.abs(error) < 0.5) return true;
				// `right` is the only property holding the host in place, so one px
				// of correction moves it exactly one px.
				const used = Number.parseFloat(computedStyle(host)?.right ?? "");
				if (!Number.isFinite(used)) return true;
				host.style.right = `${used - error}px`;
			}
			return true;
		}

		/**
		 * Hang the host immediately left of the magnifier, `gap` px away.
		 *
		 * The percentage is only a starting point: an element carrying a
		 * `transform` (themes animate these headers) becomes the containing block
		 * for absolutely positioned descendants, and a percentage would then
		 * resolve against the wrong box. So the rendered result is measured and
		 * corrected instead of trusted — which is also what keeps the injected
		 * button in the same rhythm as DSH's own icons when a theme or a future
		 * build re-shapes the row.
		 * @param host - the owned host element, already inserted in the document.
		 * @param searchButton - the magnifier.
		 * @param gap - target spacing in px.
		 */
		function alignInlineHost(host, searchButton, gap) {
			host.style.right = `calc(100% + ${gap}px)`;
			if (verifyIconGap(host, searchButton, gap)) return;
			// React commits asynchronously, so a host rendered in this pass has no
			// box yet; one frame later it does.
			if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
			window.requestAnimationFrame(() => { verifyIconGap(host, searchButton, gap); });
		}

		/**
		 * Keep one inline host mounted immediately left of the search control.
		 *
		 * The host is deliberately taken OUT of the flex flow (`position:absolute`
		 * on the control's line): the search slot only budgets 28px for itself, so
		 * a button participating in that row squeezes the magnifier sideways.
		 * Absolute placement costs the row nothing, so the magnifier stays exactly
		 * where DSH put it, and the button keeps the row's own spacing to its
		 * left. The line is released from `overflow:hidden` inline, because the
		 * host sits just outside its box; teardown puts both back.
		 * Idempotent: an existing host is re-positioned and re-rendered.
		 * @param props - component props for the inline entry.
		 * @returns true when the inline button is in the document.
		 */
		function placeInlineHost(props) {
			const searchButton = findSearchButton();
			if (searchButton === null) return false;
			const parts = findSearchParts(searchButton);
			if (parts === null) return false;
			const { control, row } = parts;
			let host = existingHost();
			if (host === null) {
				host = document.createElement("span");
				host.setAttribute(HOST_ATTR, HOST_VALUE);
			}
			const hostStyle = host.style;
			hostStyle.position = "absolute";
			hostStyle.top = "50%";
			// Starting point only; alignInlineHost corrects it against the live row.
			hostStyle.right = "100%";
			hostStyle.transform = "translateY(-50%)";
			hostStyle.marginRight = "0px";
			hostStyle.display = "flex";
			hostStyle.alignItems = "center";
			// Desktop shells can make the top strip of the window draggable, and a
			// drag region swallows pointer events entirely; opt this button out the
			// way the shell's own controls do. A no-op in a plain browser.
			hostStyle.webkitAppRegion = "no-drag";
			// A press that becomes a native drag (an SVG or text drag) produces no
			// click at all, so nothing inside this host may be draggable.
			hostStyle.webkitUserDrag = "none";
			hostStyle.userSelect = "none";
			// A theme's decoration sitting over the header would otherwise take the
			// click meant for this button.
			hostStyle.zIndex = "5";
			row.style.position = "relative";
			// The host hangs outside the line's box, so the line must not clip it.
			row.style.overflow = "visible";
			// Marks the line as prepared by this plugin; teardown finds it again by
			// this attribute and restores the two inline styles above.
			row.setAttribute(`${HOST_ATTR}-row`, HOST_VALUE);
			// Re-assert position on every pass: the session list re-renders on its
			// own schedule, so the host may be detached or already shifted. A pass
			// that changes nothing writes nothing, which keeps this plugin's own
			// mutation from scheduling the next pass.
			if (host.parentElement !== row || host.nextSibling !== control) row.insertBefore(host, control);
			renderInto(host, props);
			// Read the gap after insertion: the host's own button is the only button
			// left of the magnifier, and readIconGap skips it.
			alignInlineHost(host, searchButton, readIconGap(row, searchButton));
			return true;
		}

		/**
		 * Mount or update one React tree inside a foreign DOM node. The node is
		 * owned by this bundle (nothing else renders into it), so a single React
		 * root is created once and reused for every later update.
		 * @param host - the owned container element.
		 * @param props - component props for the inline entry.
		 */
		function renderInto(host, props) {
			if (typeof reactDom?.createRoot !== "function") return;
			if (host.__dshMselRoot === undefined) {
				host.__dshMselRoot = reactDom.createRoot(host);
			}
			host.__dshMselRoot.render(jsx(InlineEntry, props));
		}

		/** Unmount the owned React root, detach the host, and release row styles. */
		function removeInlineHost() {
			const host = existingHost();
			if (host === null) return;
			const row = document.querySelector(`[${HOST_ATTR}-row=${JSON.stringify(HOST_VALUE)}]`);
			try {
				host.__dshMselRoot?.unmount();
			} catch {
				/* the host is going away with the plugin; nothing to recover */
			}
			host.remove();
			if (row !== null) {
				// Leave no trace of this plugin in another plugin's DOM.
				row.style.position = "";
				row.style.overflow = "";
				row.removeAttribute(`${HOST_ATTR}-row`);
			}
		}

		/**
		 * Inline entry: the same panel as the footer entry, positioned in the
		 * session-list header. It renders the modal for the whole page (portal),
		 * so the button location and the dialog are independent.
		 *
		 * Visibility lives in a plugin-level store rather than in component state,
		 * so the dialog survives this tree being rebuilt (the session list
		 * re-renders the line the button hangs on), and so the document-level
		 * click listener registered in `apply` can open it without a synthetic
		 * event ever reaching React.
		 */
		function InlineEntry({ t, actions, hooks, icons, tip, onTranslate }) {
			const panel = react.useSyncExternalStore(hooks.panel.subscribe, hooks.panel.getSnapshot);
			const open = panel.open === true;
			react.useEffect(() => {
				if (typeof onTranslate === "function") onTranslate(t);
			}, [t, onTranslate]);
			const close = react.useCallback(() => { hooks.panel.set({ open: false }); }, [hooks]);
			// The document-level listener has already stamped the event if it acted;
			// this is the backup path, and opening twice is idempotent.
			const show = react.useCallback((event) => {
				const native = event?.nativeEvent ?? event;
				if (native !== null && native !== undefined && native[ENTRY_MARK] === true) {
					note("click react skipped");
					return;
				}
				if (native !== null && native !== undefined) {
					try {
						native[ENTRY_MARK] = true;
					} catch {
						/* not stampable: nothing else will see this activation */
					}
				}
				note("click react");
				// The injected button has now proven it can be clicked here, so the
				// footer fallback may retire (see MultiSelectEntry).
				actions.markInlineProven?.();
				actions.entry?.();
			}, [actions]);
			return jsx(react.Fragment, { children: [
				tip(t("entry.tip"), jsx("button", {
					type: "button",
					className: "dsh-msel-inline",
					// A press that turns into a native drag never produces a click;
					// refusing to be draggable is what keeps this a plain button.
					draggable: false,
					"data-open": open ? "true" : "false",
					"aria-label": t("entry.label"),
					"aria-expanded": open,
					onClick: show,
					children: jsx(icons.checklist, { size: 16 })
				}), "bottom"),
				jsx(ui.Modal, {
					open,
					onClose: close,
					title: t("panel.title"),
					closeLabel: t("panel.close"),
					description: t("panel.description"),
					children: open
						? jsx(PanelBoundary, {
							format: (reason) => t("error.render", { reason }),
							children: jsx(MultiSelectPanel, { t, actions, hooks, icons, tip })
						})
						: null
				})
			] });
		}

		/**
		 * Footer entry: the fallback view beside Settings.
		 *
		 * It appears only when the header button could NOT be placed, so the
		 * sidebar never carries two entry points: the header button is the entry
		 * point the user asked for, and this is the safety net for a DSH build
		 * that no longer renders the search control.
		 *
		 * The stores arrive as `seats`, NOT as `hooks`: an entry's `inject()`
		 * face owns the key `hooks` as the slot renderer's injected-hook DSL —
		 * the renderer binds every member as a `use<Name>` prop and deletes the
		 * key before rendering (`dsh-client-ui-renderer`'s `runInject` →
		 * `bindInjectSources`). Passing the snapshot stores under `hooks` made
		 * the component read `undefined` on every render, which crashed it; the
		 * slot then retired the entry (`active: false` in slot inspection)
		 * instead of rendering the fallback button. `hooks` is still accepted
		 * for this plugin's own React root and for the mount tests.
		 */
		function MultiSelectEntry({ t, actions, seats, hooks, icons, tip, onTranslate }) {
			const bus = seats ?? hooks;
			// The dialog is the same one the inline view shows: one panel store for
			// both entries means the button location never decides whether an open
			// dialog survives.
			const panel = react.useSyncExternalStore(bus.panel.subscribe, bus.panel.getSnapshot);
			const open = panel.open === true;
			const list = react.useSyncExternalStore(bus.sessions.subscribe, bus.sessions.getSnapshot);
			// Placement is another plugin-owned snapshot in the standard hook seat,
			// so the fallback button reacts without the panel being remounted.
			const placement = react.useSyncExternalStore(bus.placement.subscribe, bus.placement.getSnapshot);
			react.useEffect(() => {
				if (typeof onTranslate === "function") onTranslate(t);
			}, [t, onTranslate]);
			const items = snapshotItems(list);
			// The badge counts conversations a user can actually open — the same
			// population the panel lists, so subagent sessions are excluded here too.
			let total = 0;
			for (const item of items) if (item.blank !== true && item.origin !== "subagent") total += 1;
			const close = react.useCallback(() => { bus.panel.set({ open: false }); }, [bus]);
			const show = react.useCallback((event) => {
				// Recorded because this entry runs through the app's own React tree:
				// if it opens the panel while the injected button does not, the
				// problem is the injected DOM, not the panel.
				const native = event?.nativeEvent ?? event;
				if (native !== null && native !== undefined && native[ENTRY_MARK] === true) {
					note("click footer skipped");
					return;
				}
				if (native !== null && native !== undefined) {
					try {
						native[ENTRY_MARK] = true;
					} catch {
						/* not stampable: nothing else will see this activation */
					}
				}
				note("click footer");
				actions.entry?.();
			}, [actions]);
			// The modal stays mounted in this view even while the button is
			// hidden, so a session opened from the header button keeps its dialog.
			return jsx(react.Fragment, { children: [
				tip(t("entry.tip"), jsx("button", {
					type: "button",
					className: "dsh-msel-entry",
					style: placement.inline === true ? { display: "none" } : undefined,
					"aria-label": t("entry.label"),
					"aria-expanded": open,
					onClick: show,
					children: [
						jsx(icons.checklist, {}),
						total > 0 ? jsx("span", { className: "dsh-msel-entryCount", children: total > 99 ? "99+" : String(total) }) : null
					]
				})),
				jsx(ui.Modal, {
					open,
					onClose: close,
					title: t("panel.title"),
					closeLabel: t("panel.close"),
					description: t("panel.description"),
					children: open
						? jsx(PanelBoundary, {
							format: (reason) => t("error.render", { reason }),
							children: jsx(MultiSelectPanel, { t, actions, hooks: bus, icons, tip })
						})
						: null
				})
			] });
		}

		// ---------------------------------------------------------------------
		// Plugin
		// ---------------------------------------------------------------------

		/** Services the panel needs before it can mount. */
		const inject = ["slots", "locale", "sessions"];

		/**
		 * Mount the multi-select entry, panel, and batch action port.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			installStyles();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-multiselect: dictionaries");

			// A missing platform package is no longer fatal: every control this
			// plugin draws has a local implementation behind the same call (see the
			// `ui` table above), so the honest outcome is a note naming which chrome
			// is in use — not a plugin that never appears.
			if (typeof jsx !== "function" || typeof jsxs !== "function") throw new Error("session-multiselect: react/jsx-runtime did not expose jsx/jsxs");

			// Resolved once, then handed down: which icon names this DSH ships is a
			// property of the running build, not of any one render. The ring records
			// the answer so a future rename shows up as `fallback(...)` in a report
			// instead of as a missing button.
			const resolved = resolveIcons();
			const icons = resolved.icons;
			/**
			 * Tooltips are decoration: the primitives have always shipped one, but a
			 * build without it must still get a working button. With no Tooltip to
			 * render, the label is attached to the anchor directly (a native title),
			 * which costs no wrapper element at all.
			 */
			const tip = (label, child, side) => (ui.Tooltip === primitives.Tooltip
				? jsx(ui.Tooltip, { label, delayMs: 400, ...(side === undefined ? {} : { side }), children: child })
				: LocalTooltip({ label, children: child }));

			const store = storeApi.defineStore({
				init: () => ({
					// The fallback marks: used only when this build exposes no
					// workspace service, so archiving still has somewhere to live.
					archivedIds: [],
					pinnedIds: [],
					// Set once the injected header button has been clicked in this
					// browser; the footer fallback retires on it (see MultiSelectEntry).
					inlineProven: false,
					// Grouping and filter are preferences, so the toolbar writes them into
					// this store and they persist. `groupMode` supersedes the old boolean
					// (kept so a stored 0.9 snapshot still reads correctly).
					groupMode: "workspace",
					filter: "all",
					groupByWorkspace: true
				}),
				persist: "dsh.session.multiselect.v1",
				actions: {
					/** Remember that the injected button proved clickable. */
					markInlineProven: (draft) => {
						draft.inlineProven = true;
					},
					/** Remember the user's grouping preference. */
					setGroupByWorkspace: (draft, value) => {
						draft.groupByWorkspace = value === true;
					},
					setGroupMode: (draft, mode) => {
						draft.groupMode = mode === "date" || mode === "none" ? mode : "workspace";
						draft.groupByWorkspace = draft.groupMode === "workspace";
					},
					setFilter: (draft, filter) => {
						draft.filter = filter === "running" || filter === "pinned" ? filter : "all";
					},
					/** Archive or restore the given ids in this plugin's own state. */
					setArchived: (draft, ids, archived) => {
						const next = new Set(Array.isArray(draft.archivedIds) ? draft.archivedIds : []);
						for (const id of ids) {
							if (archived) next.add(id);
							else next.delete(id);
						}
						draft.archivedIds = [...next];
					}
				}
			}).create();

			const sessions = ctx.sessions;

			/**
			 * The workspace service, when this build has one.
			 *
			 * Pinning and archiving are workspace-controller commands, not session
			 * commands: only that service can move a row into DSH's own pinned group
			 * or archive section. It is resolved lazily through `ctx.get` on every
			 * use rather than added to `inject`: a build without it must still mount
			 * the plugin (and lose only the pin button), and a required service that
			 * never arrives would keep the whole entry button from ever applying.
			 * @returns the service, or null.
			 */
			const workspacesApi = () => {
				try {
					if (typeof ctx.get !== "function") return null;
					const service = ctx.get("workspaces");
					return service === null || service === undefined ? null : service;
				} catch (error) {
					note("workspaces service failed", failureText(error));
					return null;
				}
			};

			/**
			 * Pinned/archived membership as the panel should read it.
			 *
			 * One snapshot store, two sources: the workspace service when it is
			 * there (so the panel and DSH's own list agree), this plugin's own marks
			 * otherwise. `real` says which one answered, because "archived" and
			 * "hidden inside this plugin" are different promises to make in a status
			 * line.
			 */
			const marks = storeApi.createSnapshotStore({ pinnedIds: [], archivedIds: [], real: false });
			let marksSubscribed = false;

			/** Publish the plugin's own marks, for a build without the service. */
			const syncLocalMarks = () => {
				const state = store.getSnapshot() ?? {};
				const current = marks.getSnapshot();
				if (current.real === false
					&& sameIds(current.pinnedIds, state.pinnedIds)
					&& sameIds(current.archivedIds, state.archivedIds)) return;
				marks.set({
					pinnedIds: Array.isArray(state.pinnedIds) ? [...state.pinnedIds] : [],
					archivedIds: Array.isArray(state.archivedIds) ? [...state.archivedIds] : [],
					real: false
				});
			};

			/**
			 * Re-read pinned/archived membership and publish it if it changed.
			 *
			 * Called after every batch action and on every placement pass: the
			 * service can appear late (it belongs to another plugin's apply), so the
			 * lookup is repeated rather than cached, and an unchanged answer writes
			 * nothing (the store would otherwise re-render the panel per frame).
			 * @returns whether the workspace service answered.
			 */
			const refreshMarks = () => {
				const service = workspacesApi();
				const list = service === null ? null : service.list;
				if (list === null || list === undefined || typeof list.getSnapshot !== "function") {
					syncLocalMarks();
					return false;
				}
				const snapshot = list.getSnapshot() ?? {};
				const pinnedIds = Array.isArray(snapshot.pinnedSessionIds) ? [...snapshot.pinnedSessionIds] : [];
				const archivedIds = Array.isArray(snapshot.archivedSessionIds) ? [...snapshot.archivedSessionIds] : [];
				const current = marks.getSnapshot();
				if (current.real !== true || !sameIds(current.pinnedIds, pinnedIds) || !sameIds(current.archivedIds, archivedIds)) {
					marks.set({ pinnedIds, archivedIds, real: true });
				}
				if (!marksSubscribed && typeof list.subscribe === "function") {
					marksSubscribed = true;
					try {
						list.subscribe(() => { refreshMarks(); });
						note("marks service", "subscribed");
					} catch (error) {
						note("marks subscribe failed", failureText(error));
					}
				}
				return true;
			};

			/** Command name per mark direction, on the workspace service. */
			const WORKSPACE_COMMANDS = {
				pin: "pinSession",
				unpin: "unpinSession",
				archive: "archiveSession",
				unarchive: "unarchiveSession"
			};

			/**
			 * Run one workspace command per id, collecting per-id failures.
			 *
			 * Per id, not in bulk: DSH refuses to archive a session that is still
			 * running, and one refusal must not hide the twenty that worked. The
			 * reason is kept verbatim for the report.
			 * @returns `{ ok, failed }`, or null when no command is available.
			 */
			const callWorkspaceCommands = async (kind, ids) => {
				const service = workspacesApi();
				const name = WORKSPACE_COMMANDS[kind];
				const method = service === null || name === undefined ? undefined : service[name];
				if (typeof method !== "function") return null;
				let ok = 0;
				const failed = [];
				for (const id of ids) {
					try {
						await method.call(service, id);
						ok += 1;
					} catch (error) {
						const reason = failureText(error);
						note("mark failed", `${kind} ${id.slice(0, 8)} ${reason}`);
						failed.push({ id, reason });
					}
				}
				return { ok, failed };
			};

			/**
			 * Ask the controller to re-pull the session list.
			 *
			 * A delete removes session directories on the Host, and the Host's list
			 * is built from exactly those directories — but this client only learns
			 * about it when the list is pulled again. Without this call every row
			 * the batch just deleted stays on screen, in the panel and in the native
			 * sidebar, until the page is reloaded: the delete looks like a no-op.
			 * Best effort — a build whose client service has no `refresh()` still
			 * deletes, it just keeps the stale rows until the next reload.
			 */
			const refreshSessionList = () => {
				try {
					const pending = sessions.refresh?.();
					note("sessions refresh", typeof pending?.then === "function" ? "async" : "sync");
					if (pending !== undefined && pending !== null && typeof pending.catch === "function") {
						pending.catch((error) => note("sessions refresh failed", failureText(error)));
					}
				} catch (error) {
					note("sessions refresh failed", failureText(error));
				}
			};

			/**
			 * Conversations trashed while the Host still held them open.
			 *
			 * The Host list keeps such a row until the process restarts, so without
			 * this the panel would keep showing a conversation the user just deleted.
			 * Hiding it locally makes the delete visibly work; restore clears the mark.
			 */
			const trashedWhileOpen = new Set();

			/**
			 * Largest id batch the host route accepts in one GET.
			 *
			 * Ids travel as repeated query parameters, so a few hundred of them run
			 * into the request-line limit and fail as an opaque 431. The host route
			 * refuses batches above this size, and the panel splits at the same
			 * size so a large selection still deletes (and reports) id by id.
			 */
			const DELETE_BATCH = 200;

			/**
			 * Ask the host route to delete one batch (`<= DELETE_BATCH` ids).
			 *
			 * Returns `{ ok, failed }` for this batch only; a transport failure
			 * blames every id in the batch, because none of them was touched.
			 */
			const requestDelete = async (ids) => {
				const failed = [];
				let payload;
				let status;
				try {
					// GET, not POST: DSH's Web server answers 405 to every POST
					// that reaches it (a POST to an unrouted path 405s just like a
					// routed one), so plugin routes are GET-only on this build.
					const query = new URLSearchParams();
					for (const id of ids) query.append("ids", id);
					// The panel already filtered running conversations out; the rest may
					// be loaded (opened earlier) and are trashed anyway, with `live` in
					// the result so the status line can explain the lingering sidebar row.
					query.append("force-open", "1");
					const response = await fetch(`/session-multiselect/delete?${query.toString()}`);
					status = response.status;
					// A 404 here is not "no such session" — it is "no such route",
					// i.e. the Node half in this running DSH is older than the fix
					// and never registered it. Say so, because the unhelpful
					// alternative is a bare 404 that reads like a plugin bug.
					if (status === 404) {
						const reason = "删除路由未加载：请完全退出并重启 DSH（宿主进程不会热更），然后刷新页面";
						note("delete route missing", "HTTP 404");
						return { ok: 0, failed: ids.map((id) => ({ id, reason })) };
					}
					payload = await response.json();
					if (!response.ok) {
						const reason = `HTTP ${String(status)}: ${String(payload?.error ?? "delete failed")}`;
						note("delete route failed", reason);
						return { ok: 0, failed: ids.map((id) => ({ id, reason })) };
					}
				} catch (error) {
					// Unreachable server: no id was touched, so name every one
					// rather than claiming a silent success.
					const reason = failureText(error);
					note("delete route unreachable", reason);
					return { ok: 0, failed: ids.map((id) => ({ id, reason })) };
				}

				// A session whose directory is already gone counts as deleted:
				// the user's intent is "this row must not come back".
				let ok = 0;
				let open = 0;
				const opened = [];
				for (const entry of Array.isArray(payload?.results) ? payload.results : []) {
					if (entry?.ok === true) {
						ok += 1;
						// `live` means the Host still holds the row in memory: the files
						// are in the trash, but the sidebar keeps showing it until restart.
						if (entry?.live === true) {
							open += 1;
							opened.push(String(entry?.id ?? ""));
						}
					} else {
						const reason = String(entry?.reason ?? "delete failed");
						note("delete failed", `${String(entry?.id ?? "").slice(0, 8)} ${reason}`);
						failed.push({ id: String(entry?.id ?? ""), reason });
					}
				}
				if (ok + failed.length < ids.length) {
					const seen = new Set([...failed.map((entry) => entry.id), ...ids.slice(0, ok)]);
					for (const id of ids) {
						if (seen.has(id)) continue;
						failed.push({ id, reason: "no result from the host route" });
					}
				}
				return { ok, failed, open, opened };
			};

			/**
			 * Restore trashed conversations by id.
			 *
			 * Mirrors requestDelete: one GET per batch, per-id outcomes, and a list
			 * re-pull after a success so the restored rows reappear in the panel and in
			 * DSH's own sidebar.
			 */
			const requestRestore = async (ids) => {
			  const failed = [];
			  let payload;
			  try {
			    const query = new URLSearchParams();
			    for (const id of ids) query.append("ids", id);
			    const response = await fetch(`/session-multiselect/restore?${query.toString()}`);
			    payload = await response.json();
			    if (!response.ok) {
			      const reason = `HTTP ${String(response.status)}: ${String(payload?.error ?? "restore failed")}`;
			      note("restore route failed", reason);
			      return { ok: 0, failed: ids.map((id) => ({ id, reason })) };
			    }
			  } catch (error) {
			    const reason = failureText(error);
			    note("restore route unreachable", reason);
			    return { ok: 0, failed: ids.map((id) => ({ id, reason })) };
			  }
			  let ok = 0;
			  for (const entry of Array.isArray(payload?.results) ? payload.results : []) {
			    if (entry?.ok === true) ok += 1;
			    else failed.push({ id: String(entry?.id ?? ""), reason: String(entry?.reason ?? "restore failed") });
			  }
			  if (ok > 0) refreshSessionList();
			  return { ok, failed };
			};


			const actions = {
				/**
				 * Permanently delete every selected session, collecting failures.
				 *
				 * The delete runs in the Node half: DSH's client session service has
				 * no `delete` (the runtime `ISessions` face is `list`/`open`/`fork`/
				 * `binding`/`scope`/`openSubagent` only, and the ACP agent does not
				 * advertise `sessionCapabilities.delete`), so there is nothing here
				 * to call. A stored session is a directory, and only the host
				 * process can remove it — it does so behind
				 * `GET /session-multiselect/delete`, returning one outcome per id so
				 * this report stays per-id. Requests are split at DELETE_BATCH so a
				 * very large selection does not turn into one over-long URL.
				 */
				async deleteSessions(ids) {
					// Recorded once per selection: a route that is missing is the one
					// failure whose message ("not found") hides its own cause.
					const snapshot = sessions.list.getSnapshot();
					const byId = snapshot.byId ?? {};
					const known = new Set(Object.keys(byId));
					note("delete route", `ids=${String(ids.length)} listed=${String(ids.filter((id) => known.has(id)).length)}`);
					const titleOf = (id) => {
						const row = byId[id];
						if (row === undefined || row === null) return "";
						if (typeof row.title === "string" && row.title !== "") return row.title;
						return typeof row.displayTitle === "string" ? row.displayTitle : "";
					};
					// A running conversation is refused before the request: its files are
					// being written right now, and a plugin cannot unload it. Loaded but
					// idle ones go through with force-open; the route reports them as
					// `live`, which the status line turns into "the row leaves on restart".
					const failed = [];
					const send = [];
					for (const id of ids) {
						if (byId[id]?.running === true) {
							failed.push({ id, title: titleOf(id), reason: translate("error.running") });
							continue;
						}
						send.push(id);
					}
					let ok = 0;
					let open = 0;
					for (let at = 0; at < send.length; at += DELETE_BATCH) {
						const batch = send.slice(at, at + DELETE_BATCH);
						if (at > 0) note("delete batch", `at=${String(at)} n=${String(batch.length)}`);
						const result = await requestDelete(batch);
						ok += result.ok;
						open += result.open ?? 0;
						// The Host list will keep these rows until it restarts; hide them
						// in the panel so the delete visibly worked. A restore unhides.
						for (const id of result.opened ?? []) trashedWhileOpen.add(id);
						for (const entry of result.failed) failed.push(entry);
					}
					for (const entry of failed) if (entry.title === undefined) entry.title = titleOf(entry.id);
					// The rows are gone on disk; make the list say so too.
					if (ok > 0) refreshSessionList();
					return { ok, failed, open };
				},
				/**
				 * Pin or unpin, on the real workspace service.
				 *
				 * `real` is false when the service is missing, and the callers say so
				 * instead of reporting a pin that did not happen: pinning is visible
				 * in DSH's own list, so a private mark would be a lie.
				 */
				/** The trash listing for the panel's restore view. */
				async listTrash() {
				  try {
				    const response = await fetch("/session-multiselect/trash");
				    if (!response.ok) return { error: `HTTP ${String(response.status)}` };
				    const payload = await response.json();
				    return {
				      entries: Array.isArray(payload?.entries) ? payload.entries : [],
				      retentionDays: typeof payload?.retentionDays === "number" ? payload.retentionDays : 7
				    };
				  } catch (error) {
				    return { error: failureText(error) };
				  }
				},
				/** Put trashed conversations back, then re-pull the session list. */
				async restoreSessions(ids) {
				  const result = await requestRestore(ids);
				  for (const id of ids) trashedWhileOpen.delete(id);
				  note("restore", `n=${String(ids.length)} ok=${String(result.ok)} failed=${String(result.failed.length)}`);
				  return result;
				},
				/**
				 * Which selected conversations the host still holds open.
				 *
				 * Runs the delete route's read-only probe (dry=1): one GET per
				 * DELETE_BATCH ids, no mutation. The confirmation and the row badges
				 * use it so "why is a deleted row still here" is answered up front.
				 */
				async probeOpenSessions(ids) {
					const open = new Set();
					for (let at = 0; at < ids.length; at += DELETE_BATCH) {
						const batch = ids.slice(at, at + DELETE_BATCH);
						try {
							const query = new URLSearchParams();
							for (const id of batch) query.append("ids", id);
							query.append("dry", "1");
							const response = await fetch(`/session-multiselect/delete?${query.toString()}`);
							if (!response.ok) continue;
							const payload = await response.json();
							for (const entry of Array.isArray(payload?.results) ? payload.results : []) {
								if (entry?.live === true) open.add(String(entry?.id ?? ""));
							}
						} catch (error) {
							note("open probe failed", failureText(error));
						}
					}
					return { open };
				},
				/** Permanently drop trashed conversations, then re-pull the trash. */
				async purgeTrash(ids) {
				  try {
				    const query = new URLSearchParams();
				    for (const id of ids) query.append("ids", id);
				    const response = await fetch(`/session-multiselect/purge?${query.toString()}`);
				    const payload = await response.json();
				    if (!response.ok) {
				      return { ok: false, purged: 0, failed: [{ id: "", reason: `HTTP ${String(response.status)}` }] };
				    }
				    const failed = [];
				    for (const entry of Array.isArray(payload?.results) ? payload.results : []) {
				      if (entry?.ok !== true) failed.push({ id: String(entry?.id ?? ""), reason: String(entry?.reason ?? "purge failed") });
				    }
				    note("purge", `n=${String(ids.length)} purged=${String(payload?.purged ?? 0)} failed=${String(failed.length)}`);
				    return { ok: failed.length === 0, purged: typeof payload?.purged === "number" ? payload.purged : 0, failed };
				  } catch (error) {
				    const reason = failureText(error);
				    note("purge unreachable", reason);
				    return { ok: false, purged: 0, failed: [{ id: "", reason }] };
				  }
				},
				/** Empty the whole trash in one request. */
				async purgeAllTrash() {
				  try {
				    const response = await fetch("/session-multiselect/purge?all=1");
				    const payload = await response.json();
				    if (!response.ok) return { ok: false, purged: 0, error: `HTTP ${String(response.status)}` };
				    note("purge all", `purged=${String(payload?.purged ?? 0)}`);
				    return { ok: true, purged: typeof payload?.purged === "number" ? payload.purged : 0 };
				  } catch (error) {
				    return { ok: false, purged: 0, error: failureText(error) };
				  }
				},

				async setPinned(ids, pinned) {
					const kind = pinned ? "pin" : "unpin";
					const result = await callWorkspaceCommands(kind, ids);
					note("pin", `n=${String(ids.length)} pinned=${String(pinned)} service=${result === null ? "missing" : "ok"}`);
					if (result === null) return { ok: 0, failed: [], real: false };
					refreshMarks();
					return { ...result, real: true };
				},
				/**
				 * Archive or restore, on the workspace service when there is one.
				 *
				 * The service is the honest path; the plugin's own mark is the
				 * fallback for a build that has none, and the status line tells the
				 * user which of the two just happened.
				 */
				async setArchived(ids, archived) {
					const kind = archived ? "archive" : "unarchive";
					const result = await callWorkspaceCommands(kind, ids);
					note("archive", `n=${String(ids.length)} archived=${String(archived)} service=${result === null ? "missing" : "ok"}`);
					if (result === null) {
						store.actions.setArchived(ids, archived);
						syncLocalMarks();
						return { ok: ids.length, failed: [], real: false };
					}
					refreshMarks();
					return { ...result, real: true };
				},
				/** The injected header button was clicked, so the fallback can retire. */
				markInlineProven() {
					store.actions.markInlineProven();
				},
				/**
				 * What every entry button does: open the panel.
				 *
				 * The header button, the footer fallback and the document-level
				 * trigger all call this, so the trigger and the dialog can never
				 * disagree; opening twice is idempotent.
				 */
				entry() {
					openPanel();
				}
			};

			/**
			 * Inline-placement state, shared with the footer registration through
			 * a store so hiding/showing the fallback button never remounts the
			 * panel that owns an open dialog.
			 */
			const placement = storeApi.createSnapshotStore({ inline: false });

			/**
			 * Panel visibility, owned by the plugin rather than by whichever view
			 * rendered the button. The session list re-renders the line the button
			 * hangs on, and a dialog must not disappear with the node that opened
			 * it; keeping the flag here also lets the document-level trigger below
			 * open the panel without going through a synthetic React event.
			 */
			const panel = storeApi.createSnapshotStore({ open: false });
			/** Opening is idempotent, so two triggers can race harmlessly. */
			const openPanel = () => {
				if (panel.getSnapshot().open !== true) {
					panel.set({ open: true });
					note("panel open");
				}
			};

			/**
			 * The seats the registered views read: the session list, this plugin's
			 * own store, pinned/archived membership, where the header button ended
			 * up, and whether the panel is open. One object, so every view agrees.
			 */
			const hooks = {
				sessions: sessions.list,
				store,
				marks,
				placement,
				panel,
				// A conversation the Host still holds open after a delete stays in its
				// list until restart; the panel hides it locally (see trashedWhileOpen).
				isHidden: (id) => trashedWhileOpen.has(id),
			};

			/**
			 * This bundle's own translator, used until (and unless) the slot
			 * provides one. Without it the header panel shows `panel.title` and
			 * friends verbatim, because the footer registration is what normally
			 * hands a `t` over — and that registration may never render.
			 */
			const localT = makeTranslator({
				zh,
				en,
				active: () => {
					try {
						const snapshot = ctx.locale.getSnapshot?.();
						if (typeof snapshot?.active === "string" && snapshot.active !== "") return snapshot.active;
					} catch {
						/* fall through to the browser's language */
					}
					return typeof navigator === "undefined" ? "zh" : String(navigator.language ?? "");
				}
			});

			/** Latest `t` seen by the slot component, or this bundle's own. */
			let translate = localT;
			let observers = [];
			let placementFrame = null;
			// Separate from the frame id: a pass is "queued" from the moment it is
			// scheduled, which keeps a burst of mutations to one pass even when the
			// frame callback runs before the id has been stored.
			let placementQueued = false;
			let placed = null;

			/**
			 * Re-check the button's placement on the next frame. rAF keeps a burst of
			 * mutations (React committing a subtree) to one DOM pass.
			 */
			const schedulePlacement = () => {
				if (placementQueued || typeof window === "undefined") return;
				placementQueued = true;
				placementFrame = window.requestAnimationFrame(() => {
					placementQueued = false;
					placementFrame = null;
					// Anything that fails in here would otherwise be a silent no-op in
					// a console nobody can read: the button simply never appears.
					try {
						const next = placeInlineHost({
							t: translate,
							actions,
							hooks,
							icons,
							tip,
							onTranslate: (fn) => { translate = fn; }
						});
						if (placement.getSnapshot().inline !== next) placement.set({ inline: next });
						if (placed !== next) {
							placed = next;
							note(next ? "placed" : "not placed");
						}
						if (next) recordHitTest();
					} catch (error) {
						note("place failed", failureText(error));
					}
				});
			};

			if (typeof document !== "undefined" && typeof MutationObserver === "function") {
				// The session list is rendered by another plugin and re-renders on
				// its own schedule, so placement is re-asserted after any DOM churn
				// rather than assumed to survive.
				const observer = new MutationObserver(schedulePlacement);
				observer.observe(document.body, { childList: true, subtree: true });
				observers.push(observer);
			}

			/**
			 * Open the panel from a document-level capture listener as well as from
			 * React's own `onClick`.
			 *
			 * The button hangs in another plugin's DOM, inside a React root this
			 * plugin owns. If anything about that arrangement keeps the synthetic
			 * event from reaching the handler — a capture handler above the button,
			 * a rewritten header, a shell that eats the gesture — the button would
			 * look alive and do nothing. The capture phase runs before every other
			 * handler, so the gesture cannot be intercepted first, and opening
			 * twice is harmless.
			 */
			const onDocumentClick = (event) => {
				try {
					// First presses anywhere in the window are recorded verbatim, so
					// "the button is dead" can be told apart from "this window gets
					// no mouse input at all". Bounded, so the ring stays readable.
					if (presses < PRESS_LIMIT) {
						presses += 1;
						note("click any", `at=${String(Math.round(event.clientX))},${String(Math.round(event.clientY))} target=${describeNode(event.target)}`);
					}
					const host = existingHost();
					if (host === null) {
						note("click no host");
						return;
					}
					const target = event.target;
					if (target !== null && target !== undefined && (target === host || host.contains(target))) {
						// Stamped even when the press path already acted: React's own
						// onClick runs after this listener and must not repeat it.
						const seen = entryHandled(event);
						if (releaseHandled) {
							releaseHandled = false;
							note("click after release");
							return;
						}
						if (seen) {
							note("click already handled");
							return;
						}
						note("click document");
						actions.markInlineProven?.();
						actions.entry?.();
						return;
					}
					// A click INSIDE the button's rectangle that the button did not
					// receive means something else is on top of it, and naming that
					// element is the entire diagnosis.
					if (pointInBox(host, event.clientX, event.clientY)) note("click box", `target=${describeNode(target)}`);
				} catch (error) {
					note("click failed", failureText(error));
				}
			};
			/**
			 * The press half of the gesture, and the state the release needs.
			 *
			 * A press on the injected button can arrive with NO click behind it —
			 * Chromium skips the click when the press turns into a drag (an SVG or
			 * text drag, or the shell treating the gesture as a window move), and
			 * the user is then left with a button that lights up on hover and does
			 * nothing. So the panel also opens on the RELEASE, which always
			 * arrives, as long as both ends of the gesture landed on the button.
			 */
			/** Bounds the verbatim press log so the ring stays worth reading. */
			const PRESS_LIMIT = 6;
			let presses = 0;
			let pressInHost = false;
			/**
			 * Whether the release half of the gesture already ran the entry action.
			 *
			 * Chromium sends pointerup and then click for the same gesture, so the
			 * release acts and the click that follows is skipped — otherwise one
			 * release and the click that follows would run the entry action twice. A
			 * new press clears it, so a click with no press behind it (keyboard, a
			 * synthetic `.click()`) still works.
			 */
			let releaseHandled = false;
			const insideHost = (host, target) => target !== null && target !== undefined && (target === host || host.contains(target));
			const onDocumentPointerDown = (event) => {
				try {
					// The press half of the gesture, verbatim. A press with no
					// matching click means something cancels the click; no press at
					// all means the window never saw the mouse.
					if (presses < PRESS_LIMIT) {
						presses += 1;
						note("down any", `at=${String(Math.round(event.clientX))},${String(Math.round(event.clientY))} target=${describeNode(event.target)}`);
					}
					const host = existingHost();
					if (host === null) return;
					pressInHost = insideHost(host, event.target);
					// A new press starts a new gesture, so a click that follows may act
					// again even if the previous one was handled on its release.
					releaseHandled = false;
					const target = event.target;
					if (pressInHost) return;
					const box = measureBox(host);
					if (box === null) return;
					if (pointInBox(host, event.clientX, event.clientY)) {
						note("down box", `target=${describeNode(target)}`);
						return;
					}
					// A press within a finger's width of the button is one the user
					// MEANT for it. Recording where it actually landed is the
					// difference between "nothing happened" and a fix.
					const centerX = box.left + box.width / 2;
					const centerY = box.top + box.height / 2;
					if (Math.abs(event.clientX - centerX) <= 60 && Math.abs(event.clientY - centerY) <= 60) {
						const at = `${String(Math.round(event.clientX))},${String(Math.round(event.clientY))}`;
						note("down near", `at=${at} target=${describeNode(target)}`);
					}
				} catch (error) {
					note("down failed", failureText(error));
				}
			};
			/**
			 * Release on the button runs the entry action, click or no click.
			 *
			 * The following `click` is then skipped by the stamp on that event, so
			 * one gesture means one activation even though three listeners see it.
			 */
			const onDocumentPointerUp = (event) => {
				try {
					const host = existingHost();
					const wasPress = pressInHost;
					pressInHost = false;
					if (host === null || !wasPress) return;
					if (!insideHost(host, event.target)) {
						note("up outside");
						return;
					}
					releaseHandled = true;
					note("up open");
					actions.markInlineProven?.();
					actions.entry?.();
				} catch (error) {
					note("up failed", failureText(error));
				}
			};
			/**
			 * A window-level record of the first few clicks. The plugin's own
			 * document listener can be pre-empted by another script on the same
			 * node calling `stopImmediatePropagation`, so whether a click was
			 * generated at all is only visible this early in the capture phase.
			 */
			let windowClicks = 0;
			const onWindowClick = (event) => {
				if (windowClicks >= 4) return;
				windowClicks += 1;
				note("win click", `at=${String(Math.round(event.clientX))},${String(Math.round(event.clientY))} target=${describeNode(event.target)}`);
			};
			if (typeof document !== "undefined") {
				document.addEventListener("click", onDocumentClick, true);
				document.addEventListener("pointerdown", onDocumentPointerDown, true);
				document.addEventListener("pointerup", onDocumentPointerUp, true);
			}
			if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
				window.addEventListener("click", onWindowClick, true);
			}
			// What is on top of the button right now, and what the shell resolved
			// the drag-region hint to. Recorded when it changes, not per frame.
			// The full stack, innermost first, is what names a covering layer:
			// `elementFromPoint` alone cannot say whether the top node is this
			// plugin's own icon or a theme's ornament drawn over it.
			let lastHit = "";
			const recordHitTest = () => {
				const host = existingHost();
				if (host === null) return;
				const box = measureBox(host);
				if (box === null || box.width <= 0) return;
				const centerX = box.left + box.width / 2;
				const centerY = box.top + box.height / 2;
				let stack = [];
				if (typeof document.elementsFromPoint === "function") {
					stack = document.elementsFromPoint(centerX, centerY).slice(0, 6).map((node) => {
						const label = describeNode(node);
						return node === host || host.contains(node) ? `*${label}` : label;
					});
				}
				const region = host.style.webkitAppRegion === "" ? "auto" : host.style.webkitAppRegion;
				// Which dialog, if any, owns the screen: our own panel and an app
				// dialog use the same primitive, so the label is what tells them
				// apart when a mask sits over the button.
				let dialog = "none";
				if (typeof document.querySelector === "function") {
					const card = document.querySelector('[role="dialog"]');
					if (card !== null) {
						const label = card.getAttribute("aria-label") ?? "untitled";
						dialog = `${label}${card.querySelector(".dsh-msel-root") === null ? "" : "(ours)"}`;
					}
				}
				const detail = `build=${String(BUILD)} at=${String(Math.round(centerX))},${String(Math.round(centerY))} region=${region} dialog=${dialog} stack=${stack.join(" < ")}`;
				if (detail === lastHit) return;
				lastHit = detail;
				note("hit", detail);
			};
			const marksLive = refreshMarks();
			note("apply", `build=${String(BUILD)} chrome=${chromeSource} marks=${marksLive ? "workspaces" : "local"} icons=${JSON.stringify(resolved.used)}`);

			schedulePlacement();

			ctx.effect(() => () => {
				for (const observer of observers) observer.disconnect();
				observers = [];
				if (placementFrame !== null && typeof window !== "undefined") window.cancelAnimationFrame(placementFrame);
				placementFrame = null;
				placementQueued = false;
				if (typeof document !== "undefined") {
					document.removeEventListener("click", onDocumentClick, true);
					document.removeEventListener("pointerdown", onDocumentPointerDown, true);
					document.removeEventListener("pointerup", onDocumentPointerUp, true);
				}
				if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
					window.removeEventListener("click", onWindowClick, true);
				}
				removeInlineHost();
			}, "session-multiselect: inline host teardown");

			// The footer entry is the guaranteed way in, so whether it registered is
			// worth knowing: if this throws, the header button is the only door and
			// a caller that swallows plugin errors hides it completely.
			try {
				ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
					name: "sidebar.footer.action",
					id: "session-multiselect",
					locale: NS,
					// `seats`, not `hooks`: the renderer reserves `hooks` for its
					// injected-hook DSL and deletes the key before rendering — see
					// MultiSelectEntry. A plain data key survives the merge.
					inject: () => ({
						actions,
						seats: hooks,
						icons,
						tip,
						onTranslate: (fn) => { translate = fn; }
					})
				}, MultiSelectEntry));
				note("footer entry registered");
			} catch (error) {
				note("footer entry failed", failureText(error));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.MultiSelectEntry = MultiSelectEntry;
		exports.MultiSelectPanel = MultiSelectPanel;
		exports.PanelBoundary = PanelBoundary;
		exports.InlineEntry = InlineEntry;
		exports.LocalModal = LocalModal;
		exports.LocalButton = LocalButton;
		exports.LocalInput = LocalInput;
		exports.LocalTooltip = LocalTooltip;
		exports.createLocalSnapshotStore = createLocalSnapshotStore;
		exports.defineLocalStore = defineLocalStore;
		exports.placeInlineHost = placeInlineHost;
		exports.findSearchButton = findSearchButton;
		exports.findSearchControl = findSearchControl;
		exports.findSearchParts = findSearchParts;
		exports.existingHost = existingHost;
		exports.removeInlineHost = removeInlineHost;
		exports.internals = internals;
		return module.exports;
	}
});
