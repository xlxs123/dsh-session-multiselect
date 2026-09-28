/**
 * dsh-session-multiselect — Web client bundle.
 *
 * Adds a multi-select panel for conversations to the DSH Web GUI. The native
 * sidebar owns its session rows through a `single` slot with no per-row
 * extension point, so this plugin never touches those rows: it mounts its own
 * entry into the declared `sidebar.footer.action` list slot and renders a
 * self-contained panel over the module-provided Session list.
 *
 * Contract notes that shaped this file:
 * - `dsh.client.inject` in package.json is MODULE-GRAPH arrival order, not
 *   Cordis service injection; the service gate is the exported `inject` array.
 * - Session-list data never enters zustand: it is read through the `sessions`
 *   service with `getSnapshot()`/`subscribe()` (a uSES pair).
 * - Deleting the selected session makes the host clear the AppFrame selection,
 *   so batch delete needs no extra navigation handling.
 * - Conversation history is read by instantiating the session and paging
 *   backwards with `loadOlder()`; pages arrive in log order.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-multiselect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const clientStore = require("@deepseek-ai/dsh-client-store");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const react = require("react");
		const reactDom = require("react-dom/client");
		const { jsx, jsxs } = require("react/jsx-runtime");

		// ---------------------------------------------------------------------
		// Pure helpers (no React, no DOM). Also published on
		// globalThis.__DSH_SESSION_MULTISELECT__ so this exact code path can be
		// unit tested outside a browser.
		// ---------------------------------------------------------------------

		/** Collapse whitespace to one line. */
		function inlineText(value) {
			return String(value).replace(/\s+/gu, " ").trim();
		}

		/** Render one message content part as plain text; non-text parts are labelled. */
		function partText(part) {
			if (typeof part === "string") return part;
			if (part === null || part === undefined || typeof part !== "object") return "";
			const record = part;
			switch (record.type) {
				case "text": return typeof record.text === "string" ? record.text : "";
				case "reasoning": return "";
				case "image": return "[image]";
				case "file": {
					const name = typeof record.name === "string" ? record.name : "file";
					return `[file: ${name}]`;
				}
				case "tool-call": return `[tool call: ${typeof record.name === "string" ? record.name : "unknown"}]`;
				case "tool-result": return "[tool result]";
				default: return "";
			}
		}

		/** Fold a content array (or bare string) into trimmed plain text. */
		function contentText(content) {
			if (typeof content === "string") return content.trim();
			if (!Array.isArray(content)) return "";
			return content.map(partText).filter((piece) => piece !== "").join("\n").trim();
		}

		/**
		 * Extract `{role, text}` turns from history records, in log order.
		 * Assistant reasoning and tool traffic are dropped: exports and AI
		 * aggregation want the conversation, not the harness transcript.
		 */
		function extractTurns(records) {
			const turns = [];
			for (const record of records ?? []) {
				const event = record === null || record === undefined ? undefined : record.event;
				if (event === null || event === undefined) continue;
				if (event.type === "user/message") {
					const text = contentText(event.message === undefined ? undefined : event.message.content);
					if (text !== "") turns.push({ role: "user", text });
					continue;
				}
				if (event.type === "assistant/message") {
					const text = contentText(event.message === undefined ? undefined : event.message.content);
					if (text !== "") turns.push({ role: "assistant", text });
				}
			}
			return turns;
		}

		/** First user turn, used as a title fallback for untitled sessions. */
		function firstUserText(records) {
			const turn = extractTurns(records).find((entry) => entry.role === "user");
			return turn === undefined ? "" : turn.text;
		}

		/** Resolve the display title, falling back to the first user message. */
		function sessionTitle(summary, records) {
			const title = typeof summary?.title === "string" ? summary.title.trim() : "";
			if (title !== "") return title;
			const fallback = inlineText(firstUserText(records ?? []));
			if (fallback === "") return "untitled session";
			return fallback.length > 60 ? `${fallback.slice(0, 60)}…` : fallback;
		}

		/** Filesystem-safe export file name carrying a short session id. */
		function exportBaseName(summary, records) {
			const raw = sessionTitle(summary, records);
			const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").replace(/\s+/gu, " ").trim();
			const stem = cleaned === "" ? "session" : cleaned.slice(0, 60);
			const id = typeof summary?.sessionId === "string" ? summary.sessionId : "";
			return `${stem} (${id.slice(0, 8)})`;
		}

		/** Local timestamp for export headers. */
		function stamp(value) {
			const date = new Date(typeof value === "number" ? value : Date.now());
			if (Number.isNaN(date.getTime())) return "";
			const pad = (part) => String(part).padStart(2, "0");
			return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		/** Render one session as a Markdown document. */
		function sessionMarkdown(summary, records) {
			const lines = [`# ${sessionTitle(summary, records)}`, ""];
			lines.push(`- Session ID: \`${String(summary?.sessionId ?? "")}\``);
			if (typeof summary?.cwd === "string" && summary.cwd !== "") lines.push(`- Working directory: \`${summary.cwd}\``);
			if (summary?.updatedAt !== undefined) lines.push(`- Last activity: ${stamp(summary.updatedAt)}`);
			lines.push(`- Exported: ${stamp(Date.now())}`, "");
			for (const turn of extractTurns(records)) {
				lines.push(turn.role === "user" ? "## User" : "## Assistant", "", turn.text, "");
			}
			return lines.join("\n");
		}

		/** Serialize one session as a structured JSON document. */
		function sessionJson(summary, records) {
			return JSON.stringify({
				sessionId: summary?.sessionId,
				title: sessionTitle(summary, records),
				cwd: summary?.cwd,
				updatedAt: summary?.updatedAt,
				exportedAt: new Date().toISOString(),
				turns: extractTurns(records)
			}, null, 2);
		}

		/** Instruction prepended to the aggregated transcripts sent to a new session. */
		const SYNTHESIS_INSTRUCTION = [
			"以下是我从 DSH 里选出的多个历史对话的完整记录（仅含用户与助手正文，不含工具调用）。",
			"",
			"请完成两件事：",
			"1. 逐个对话给出简短摘要（各 3-5 条要点）。",
			"2. 横向对比它们的异同：目标、结论、遗留问题与重复劳动，并给出可执行的下一步建议。",
			"",
			"如果内容被截断，请明确指出哪些部分不完整，不要臆测缺失内容。"
		].join("\n");

		/** Cut transcript parts to a character budget, reporting what survived. */
		function truncateToBudget(parts, budget) {
			const total = parts.reduce((sum, part) => sum + part.length, 0);
			if (total <= budget) return { text: parts.join("\n\n---\n\n"), truncated: false, kept: parts.length };
			const kept = [];
			let used = 0;
			for (const part of parts) {
				if (used + part.length > budget) break;
				kept.push(part);
				used += part.length;
			}
			if (kept.length === 0) return { text: parts.length === 0 ? "" : parts[0].slice(0, Math.max(0, budget)), truncated: true, kept: parts.length === 0 ? 0 : 1 };
			return { text: kept.join("\n\n---\n\n"), truncated: true, kept: kept.length };
		}

		/**
		 * Compose the aggregation target message.
		 * @returns the prompt text plus the truncation facts the caller reports.
		 */
		function buildSynthesisPrompt(entries, budget) {
			const cut = truncateToBudget(entries.map(({ summary, records }) => sessionMarkdown(summary, records)), budget);
			const notice = cut.truncated
				? `\n\n> 注意：内容超出长度上限，只包含所选中对话的前 ${String(cut.kept)} / ${String(entries.length)} 个。`
				: "";
			return {
				text: `${SYNTHESIS_INSTRUCTION}${notice}\n\n---\n\n${cut.text}`,
				truncated: cut.truncated,
				kept: cut.kept,
				total: entries.length
			};
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
		 * Flatten the session list into the panel's display order: pinned rows
		 * first, then everything else, each by recency. Archived rows are dropped
		 * unless the caller asks for them; blank sessions are never rows, and a
		 * summary with no usable id is skipped rather than allowed to collapse
		 * every row onto one key.
		 */
		function visibleRows(snapshot, state, query, showArchived) {
			const items = snapshotItems(snapshot);
			const archived = new Set(state?.archivedIds ?? []);
			const pinned = new Set(state?.pinnedIds ?? []);
			const unread = new Set(state?.unreadIds ?? []);
			const needle = String(query ?? "").trim().toLowerCase();
			const rows = [];
			for (const summary of items) {
				if (summary === null || summary === undefined) continue;
				if (summary.blank === true) continue;
				if (typeof summary.sessionId !== "string" || summary.sessionId === "") continue;
				const isArchived = archived.has(summary.sessionId);
				if (isArchived && !showArchived) continue;
				const title = typeof summary.title === "string" ? summary.title : "";
				if (needle !== ""
					&& !title.toLowerCase().includes(needle)
					&& !String(summary.cwd ?? "").toLowerCase().includes(needle)
					&& !summary.sessionId.toLowerCase().includes(needle)) continue;
				rows.push({
					sessionId: summary.sessionId,
					title,
					cwd: typeof summary.cwd === "string" ? summary.cwd : "",
					updatedAt: typeof summary.updatedAt === "number" ? summary.updatedAt : 0,
					running: summary.running === true,
					archived: isArchived,
					pinned: pinned.has(summary.sessionId),
					unread: unread.has(summary.sessionId)
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
		 * Split display rows into workspace groups.
		 *
		 * Rows arrive already ordered by {@link visibleRows} (pinned first, then by
		 * recency) and grouping must not disturb that: a group keeps the incoming
		 * order of its members. Groups are then ordered by their most recent
		 * member, so the workspace the user just worked in heads the list.
		 * Sessions with no recorded workspace form one trailing group — they are
		 * the ones least likely to be looked for, and separating them keeps the
		 * named headings meaningful.
		 * @param rows - rows from {@link visibleRows}.
		 * @param byWorkspace - false collapses everything into one anonymous group.
		 * @returns groups of `{ key, path, label, latest, rows }` in display order.
		 */
		function groupRows(rows, byWorkspace) {
			const list = Array.isArray(rows) ? rows : [];
			if (byWorkspace === false) {
				return list.length === 0 ? [] : [{ key: "", path: "", label: "", latest: 0, rows: list }];
			}
			const groups = new Map();
			for (const row of list) {
				const cwd = typeof row?.cwd === "string" ? row.cwd : "";
				const group = groups.get(cwd);
				if (group === undefined) {
					groups.set(cwd, {
						key: cwd,
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

		/** Trigger one browser download for generated text. */
		function downloadText(fileName, text, mime) {
			const blob = new Blob([text], { type: `${mime};charset=utf-8` });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = fileName;
			anchor.rel = "noopener";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			window.setTimeout(() => { URL.revokeObjectURL(url); }, 0);
		}

		/** One-line failure text for collected batch results. */
		function failureText(error) {
			if (error === null || error === undefined) return "unknown error";
			if (typeof error === "string") return error;
			const code = typeof error.code === "string" ? error.code : "";
			const message = typeof error.message === "string" ? error.message : String(error);
			return code === "" ? message : `${code}: ${message}`;
		}

		const internals = {
			inlineText,
			partText,
			contentText,
			extractTurns,
			firstUserText,
			sessionTitle,
			exportBaseName,
			stamp,
			sessionMarkdown,
			sessionJson,
			buildSynthesisPrompt,
			truncateToBudget,
			snapshotItems,
			normalizeSummary,
			makeTranslator,
			visibleRows,
			workspaceLabel,
			groupRows,
			flattenGroups,
			toggleSelection,
			applyRange,
			selectAll,
			invertSelection,
			pruneSelection,
			downloadText,
			failureText,
			SYNTHESIS_INSTRUCTION
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
		const DIAG_LIMIT = 40;
		/**
		 * Bumped whenever this file changes. The ring records it, which is the
		 * only way to tell whether the running window actually reloaded a fix —
		 * a client bundle can be served fresh while the page keeps the old one.
		 */
		const BUILD = 15;

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
.dsh-msel-count{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-left:auto;white-space:nowrap}
.dsh-msel-list{border:0.5px solid var(--dsw-alias-border-l4,#0000001a);border-radius:12px;overflow:auto;max-height:min(46vh,420px);min-height:120px}
.dsh-msel-row{display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);border-bottom:0.5px solid var(--dsw-alias-border-l4,#0000001a)}
.dsh-msel-row:last-child{border-bottom:none}
/* Workspace heading: sticky so the section keeps a name while its rows scroll. */
.dsh-msel-group{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;user-select:none;background:var(--dsw-alias-bg-elevated,#f7f7f8);border-bottom:0.5px solid var(--dsw-alias-border-l4,#0000001a);color:var(--dsw-alias-label-secondary)}
.dsh-msel-group:hover{color:var(--dsw-alias-label-primary)}
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
.dsh-msel-box{flex:none;width:16px;height:16px;border-radius:5px;border:1.5px solid var(--dsw-alias-border-l4,#00000033);display:inline-flex;align-items:center;justify-content:center;color:transparent;font-size:11px;line-height:1}
.dsh-msel-row[data-selected="true"] .dsh-msel-box{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff}
.dsh-msel-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.dsh-msel-title{font-size:13px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-msel-meta{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);min-width:0}
.dsh-msel-cwd{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.dsh-msel-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-msel-tag{flex:none;font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l4,#0000001a);color:var(--dsw-alias-label-tertiary)}
.dsh-msel-empty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dsh-msel-actions{display:flex;flex-wrap:wrap;gap:6px}
.dsh-msel-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;min-height:0}
.dsh-msel-status:empty{display:none}
.dsh-msel-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsh-msel-status[data-tone="warning"]{color:var(--dsw-alias-label-secondary)}
.dsh-msel-confirm{border:0.5px solid var(--dsw-alias-state-error-primary,#d92d20);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dsh-msel-confirmText{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}
/* Armed delete: proof on the button itself that the click landed, so a
   confirmation the user has not scrolled to is not a dead end. The emphasis is
   this plugin's own class: the primitives' variant vocabulary changed in 0.10
   (solid became primary), and "delete" must stay red through that. */
.dsh-msel-actions button[data-armed="true"]{outline:2px solid var(--dsw-alias-state-error-primary,#d92d20);outline-offset:1px}
.dsh-msel-danger{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsh-msel-busy{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-msel-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:4px}
.dsh-msel-entry{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:2px;background:transparent;border:none;border-radius:50%;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dsh-msel-entry:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d);color:var(--dsw-alias-label-primary)}
.dsh-msel-entry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}
.dsh-msel-entryCount{font-size:10px;line-height:1}
/* 28px square: the box DSH gives its own header icons, so the row's buttons keep
   one rhythm. No margin or gap here — the distance to the magnifier is measured
   from the live row (see alignInlineHost) and set inline on the host. The
   app-region opt-out keeps a frameless shell from treating the click as a window
   drag; it is inert everywhere else. */
.dsh-msel-inline{corner-shape:round;cursor:pointer;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:none;border-radius:50%;color:var(--dsw-alias-label-secondary);padding:0;flex:none;-webkit-app-region:no-drag;user-select:none;-webkit-user-drag:none}
.dsh-msel-inline:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d);color:var(--dsw-alias-label-primary)}
.dsh-msel-inline:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}
/* While the panel is open the button stays lit, so the trigger and the dialog
   read as one control (and a click that lands is visible even if a dialog is
   slow to appear). */
.dsh-msel-inline[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover,#0000000d);color:var(--dsw-alias-label-primary)}
`;

		/**
		 * The primitives this bundle cannot render without.
		 *
		 * Kept deliberately short. The module table is a build-time contract, so a
		 * renamed export must be noticed — but only for the exports that build the
		 * dialog itself. DSH 0.10 renamed every icon (`IconSearchOutline16` became
		 * `IconSearchOutlineRegular`) and dropped the old names; requiring one
		 * exact spelling would have turned that into "the plugin does not load"
		 * when the honest outcome is "the plugin uses its own copy of the glyph".
		 */
		const REQUIRED_PRIMITIVES = ["Modal", "Button", "Input"];

		/** Export names each icon has shipped under, newest first. */
		const ICON_NAMES = {
			search: ["IconSearchOutlineRegular", "IconSearchOutlineMedium", "IconSearchOutline16"],
			checklist: ["IconChecklistOutlineRegular", "IconChecklistOutlineMedium", "IconChecklistOutline14"],
			loading: ["IconLoadingOutlineRegular", "IconLoadingOutlineMedium", "IconLoadingOutline16"]
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
				const found = (ICON_NAMES[key] ?? []).find((name) => typeof primitives[name] === "function");
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
			"entry.tip": "多选对话：批量删除 / 导出 / 汇总",
			"panel.title": "多选对话",
			"panel.description": "勾选多个对话后执行批量操作。",
			"panel.close": "关闭",
			"search.placeholder": "搜索标题或路径",
			"all.select": "全选",
			"all.invert": "反选",
			"all.clear": "清空",
			"option.archived": "显示归档",
			"option.group": "按工作区分组",
			"group.count": "{n}/{m}",
			"group.noWorkspace": "未指定工作区",
			"group.toggle": "全选/取消全选该工作区",
			"count.selected": "已选 {n} / 共 {m}",
			"list.empty": "没有可选的对话。",
			"list.emptyFiltered": "没有匹配的对话。",
			"row.pinned": "已置顶",
			"row.archived": "已归档",
			"row.running": "运行中",
			"row.unread": "未读",
			"action.delete": "删除",
			"action.fork": "Fork",
			"action.exportMd": "导出 MD",
			"action.exportJson": "导出 JSON",
			"action.synthesize": "汇总给 AI",
			"action.unread": "标为未读",
			"action.read": "标为已读",
			"action.pin": "置顶",
			"action.unpin": "取消置顶",
			"action.archive": "归档",
			"action.unarchive": "取消归档",
			"hint": "提示：点击行切换勾选；Shift+点击按范围选择；点击工作区标题可整组勾选。",
			"confirm.delete": "将永久删除 {n} 个对话及其全部记录，无法撤销。确认删除？",
			"confirm.yes": "永久删除",
			"confirm.no": "取消",
			"busy.reading": "正在读取对话记录…",
			"error.render": "面板渲染失败，已记录原因：{reason}",
			"status.deleted": "已删除 {n} 个对话。",
			"status.deleteFailed": "已删除 {ok} 个，{fail} 个失败：",
			"status.forked": "已 Fork {n} 个对话。",
			"status.forkFailed": "已 Fork {ok} 个，{fail} 个失败：",
			"status.exported": "已导出 {n} 个文件。",
			"status.exportEmpty": "选中的对话没有可导出的消息。",
			"status.synthesized": "已在 1 个新对话中汇总 {n} 个对话，正在打开…",
			"status.synthesizeTruncated": "内容超长，已截断到前 {n} 个对话。",
			"status.markedUnread": "已将 {n} 个对话标为未读。",
			"status.markedRead": "已将 {n} 个对话标为已读。",
			"status.pinned": "已置顶 {n} 个对话。",
			"status.unpinned": "已取消置顶 {n} 个对话。",
			"status.archived": "已归档 {n} 个对话（仅本插件内隐藏）。",
			"status.unarchived": "已取消归档 {n} 个对话。",
			"status.nothing": "请先勾选至少一个对话。",
			"status.readFailed": "读取 {n} 个对话记录失败：",
			"status.noRecord": "没有读到对话记录（可能尚未写入历史）。"
		};

		const en = {
			"entry.label": "Multi-select",
			"entry.tip": "Multi-select conversations: batch delete / export / summarize",
			"panel.title": "Multi-select conversations",
			"panel.description": "Tick several conversations, then run one batch action.",
			"panel.close": "Close",
			"search.placeholder": "Search title or path",
			"all.select": "Select all",
			"all.invert": "Invert",
			"all.clear": "Clear",
			"option.archived": "Show archived",
			"option.group": "Group by workspace",
			"group.count": "{n}/{m}",
			"group.noWorkspace": "No workspace",
			"group.toggle": "Select or clear this whole workspace",
			"count.selected": "{n} of {m} selected",
			"list.empty": "No selectable conversations.",
			"list.emptyFiltered": "No conversation matches.",
			"row.pinned": "Pinned",
			"row.archived": "Archived",
			"row.running": "Running",
			"row.unread": "Unread",
			"action.delete": "Delete",
			"action.fork": "Fork",
			"action.exportMd": "Export MD",
			"action.exportJson": "Export JSON",
			"action.synthesize": "Summarize with AI",
			"action.unread": "Mark unread",
			"action.read": "Mark read",
			"action.pin": "Pin",
			"action.unpin": "Unpin",
			"action.archive": "Archive",
			"action.unarchive": "Unarchive",
			"hint": "Click a row to toggle; Shift+click selects a range; click a workspace heading to take the whole group.",
			"confirm.delete": "Permanently delete {n} conversation(s) and all of their records. This cannot be undone. Delete?",
			"confirm.yes": "Delete permanently",
			"confirm.no": "Cancel",
			"busy.reading": "Reading conversation history…",
			"error.render": "The panel failed to render: {reason}",
			"status.deleted": "Deleted {n} conversation(s).",
			"status.deleteFailed": "Deleted {ok}, {fail} failed: ",
			"status.forked": "Forked {n} conversation(s).",
			"status.forkFailed": "Forked {ok}, {fail} failed: ",
			"status.exported": "Exported {n} file(s).",
			"status.exportEmpty": "The selected conversations hold no exportable messages.",
			"status.synthesized": "Aggregated {n} conversation(s) into a new session; opening it…",
			"status.synthesizeTruncated": "Content was too large; truncated to the first {n} conversation(s).",
			"status.markedUnread": "Marked {n} conversation(s) unread.",
			"status.markedRead": "Marked {n} conversation(s) read.",
			"status.pinned": "Pinned {n} conversation(s).",
			"status.unpinned": "Unpinned {n} conversation(s).",
			"status.archived": "Archived {n} conversation(s) (hidden inside this plugin).",
			"status.unarchived": "Unarchived {n} conversation(s).",
			"status.nothing": "Select at least one conversation first.",
			"status.readFailed": "Failed to read {n} conversation history: ",
			"status.noRecord": "No conversation records were found (the log may not be written yet)."
		};

		// Published for the tests: the dictionaries are the key-set source of truth
		// for the panel's copy, so a test can translate without the slot's `t`.
		internals.dicts = { zh, en };

		const NS = "sessionMultiselect";
		/** Character budget for the aggregated synthesis prompt. */
		const SYNTHESIS_BUDGET = 120000;
		/** Messages pulled per history page while reading a transcript. */
		const PAGE_MESSAGES = 200;
		/** Hard cap on history pages per session, so one huge log cannot stall the panel. */
		const MAX_PAGES = 20;

		// ---------------------------------------------------------------------
		// Panel
		// ---------------------------------------------------------------------

		/** The multi-select panel body, rendered inside the primitives' Modal. */
		function MultiSelectPanel({ actions, hooks, t, icons }) {
			const list = react.useSyncExternalStore(hooks.sessions.subscribe, hooks.sessions.getSnapshot);
			const state = react.useSyncExternalStore(hooks.store.subscribe, hooks.store.getSnapshot);
			const [query, setQuery] = react.useState("");
			const [showArchived, setShowArchived] = react.useState(false);
			const [selected, setSelected] = react.useState(() => new Set());
			const [cursor, setCursor] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [confirming, setConfirming] = react.useState(false);
			const [status, setStatus] = react.useState(null);
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
			const rows = react.useMemo(() => visibleRows(list, state, query, showArchived), [list, state, query, showArchived]);
			// Grouping reorders rows, so `order` — the list Shift+click and select-all
			// walk — must come from the grouped layout rather than from `rows`.
			const grouped = state?.groupByWorkspace !== false;
			const groups = react.useMemo(() => groupRows(rows, grouped), [rows, grouped]);
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

			const selectedIds = react.useMemo(() => order.filter((id) => selected.has(id)), [order, selected]);
			const count = selectedIds.length;
			const allRowsSelected = order.length > 0 && order.every((id) => selected.has(id));
			const progress = (done, total) => { report(`${t("busy.reading")} ${String(done)}/${String(total)}`, "info"); };
			const failList = (failed) => failed.map((entry) => `• ${entry.id.slice(0, 8)}: ${entry.reason}`).join("\n");

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

			const doDelete = guard(async (ids) => {
				note("delete start", `n=${String(ids.length)}`);
				const result = await actions.deleteSessions(ids);
				note("delete done", `ok=${String(result.ok)} failed=${String(result.failed.length)}${result.failed.length === 0 ? "" : ` ${result.failed.map((entry) => entry.reason).join(" | ")}`}`);
				setSelected(new Set());
				setConfirming(false);
				if (result.failed.length === 0) report(t("status.deleted", { n: result.ok }), "info");
				else report(`${t("status.deleteFailed", { ok: result.ok, fail: result.failed.length })}\n${failList(result.failed)}`, "error");
			});

			const doFork = guard(async (ids) => {
				const result = await actions.forkSessions(ids);
				if (result.failed.length === 0) report(t("status.forked", { n: result.ok }), "info");
				else report(`${t("status.forkFailed", { ok: result.ok, fail: result.failed.length })}\n${failList(result.failed)}`, "error");
			});

			const doExport = (format) => guard(async (ids) => {
				const read = await actions.readTranscripts(ids, progress);
				const usable = read.entries.filter((entry) => entry.records.length > 0);
				if (usable.length === 0) {
					report(t("status.exportEmpty"), "warning");
					return;
				}
				for (const entry of usable) {
					const base = exportBaseName(entry.summary, entry.records);
					if (format === "md") downloadText(`${base}.md`, sessionMarkdown(entry.summary, entry.records), "text/markdown");
					else downloadText(`${base}.json`, sessionJson(entry.summary, entry.records), "application/json");
				}
				if (read.failed.length > 0) {
					report(`${t("status.exported", { n: usable.length })}\n${t("status.readFailed", { n: read.failed.length })}\n${failList(read.failed)}`, "warning");
					return;
				}
				report(t("status.exported", { n: usable.length }), "info");
			});

			const doSynthesize = guard(async (ids) => {
				const read = await actions.readTranscripts(ids, progress);
				const usable = read.entries.filter((entry) => entry.records.length > 0);
				if (usable.length === 0) {
					report(t("status.exportEmpty"), "warning");
					return;
				}
				const outcome = await actions.synthesize(usable);
				const suffix = outcome.truncated ? `\n${t("status.synthesizeTruncated", { n: outcome.kept })}` : "";
				report(`${t("status.synthesized", { n: usable.length })}${suffix}`, outcome.truncated ? "warning" : "info");
			});

			const flag = (mode) => guard((ids) => {
				hooks.store.actions.markMany(mode, ids);
				const key = {
					unread: "status.markedUnread",
					read: "status.markedRead",
					pin: "status.pinned",
					unpin: "status.unpinned",
					archive: "status.archived",
					unarchive: "status.unarchived"
				}[mode];
				report(t(key, { n: ids.length }), "info");
			});

			const disabled = busy || count === 0;
			const actionButton = (label, onClick, variant) => jsx(primitives.Button, {
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
					tabIndex: 0,
					"aria-selected": isSelected,
					"data-selected": isSelected ? "true" : "false",
					onClick: (event) => { onRowClick(event, row.sessionId); },
					onKeyDown: (event) => {
						if (event.key === " " || event.key === "Enter") {
							event.preventDefault();
							onRowClick(event, row.sessionId);
						}
					},
					children: [
						jsx("span", { className: "dsh-msel-box", "aria-hidden": "true", children: "✓" }),
						jsx("span", { className: "dsh-msel-main", children: [
							jsx("span", { className: "dsh-msel-title", children: row.title === "" ? row.sessionId.slice(0, 8) : row.title }),
							jsx("span", { className: "dsh-msel-meta", children: [
								row.pinned ? jsx("span", { className: "dsh-msel-tag", children: t("row.pinned") }) : null,
								row.archived ? jsx("span", { className: "dsh-msel-tag", children: t("row.archived") }) : null,
								row.running ? jsx("span", { className: "dsh-msel-tag", children: t("row.running") }) : null,
								// The heading above already names the workspace, so the
								// per-row path would only repeat it.
								grouped || row.cwd === "" ? null : jsx("span", { className: "dsh-msel-cwd", children: row.cwd }),
								jsx("span", { children: stamp(row.updatedAt) })
							] })
						] }),
						row.unread ? jsx("span", { className: "dsh-msel-dot", title: t("row.unread") }) : null
					]
				}, row.sessionId);
			};

			/** The heading that names one workspace and selects all of it. */
			const renderGroup = (group) => {
				const ids = group.rows.map((row) => row.sessionId);
				const chosen = ids.filter((id) => selected.has(id)).length;
				const all = ids.length > 0 && chosen === ids.length;
				// The heading carries the whole path: two workspaces can share a last
				// segment, and the full path is what the user recognises.
				const name = group.path === "" ? t("group.noWorkspace") : group.path;
				const short = group.label === "" ? t("group.noWorkspace") : group.label;
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

			return jsx("div", { className: "dsh-msel-root", children: [
				jsx("div", { className: "dsh-msel-toolbar", children: [
					jsx(primitives.Input, {
						className: "dsh-msel-search",
						icon: jsx(icons.search, {}),
						placeholder: t("search.placeholder"),
						"aria-label": t("search.placeholder"),
						value: query,
						onChange: (event) => { setQuery(event.target.value); }
					}),
					jsx(primitives.Button, {
						size: "sm",
						disabled: order.length === 0,
						onClick: () => { setSelected((current) => (allRowsSelected ? new Set() : selectAll(current, order))); },
						children: allRowsSelected ? t("all.clear") : t("all.select")
					}),
					jsx(primitives.Button, {
						size: "sm",
						disabled: order.length === 0,
						onClick: () => { setSelected((current) => invertSelection(current, order)); },
						children: t("all.invert")
					}),
					jsx("label", { className: "dsh-msel-hint", children: [
						jsx("input", {
							type: "checkbox",
							checked: grouped,
							onChange: (event) => { hooks.store.actions.setGroupByWorkspace(event.target.checked); }
						}),
						t("option.group")
					] }),
					jsx("label", { className: "dsh-msel-hint", children: [
						jsx("input", {
							type: "checkbox",
							checked: showArchived,
							onChange: (event) => { setShowArchived(event.target.checked); }
						}),
						t("option.archived")
					] }),
					jsx("span", { className: "dsh-msel-count", children: t("count.selected", { n: count, m: order.length }) })
				] }),
				jsx("div", {
					className: "dsh-msel-list",
					role: "listbox",
					"aria-multiselectable": "true",
					"aria-label": t("panel.title"),
					children: rows.length === 0
						? jsx("div", { className: "dsh-msel-empty", children: String(query).trim() === "" ? t("list.empty") : t("list.emptyFiltered") })
						: groups.flatMap((group) => (grouped ? [renderGroup(group), ...group.rows.map(renderRow)] : group.rows.map(renderRow)))
				}),
				confirming ? jsx("div", { ref: confirmRef, className: "dsh-msel-confirm", children: [
					jsx("div", { className: "dsh-msel-confirmText", children: t("confirm.delete", { n: count }) }),
					jsx("div", { className: "dsh-msel-toolbar", children: [
						jsx(primitives.Button, {
							size: "sm",
							disabled: busy,
							className: "dsh-msel-danger",
							onClick: () => { void doDelete(); },
							children: t("confirm.yes")
						}),
						jsx(primitives.Button, { size: "sm", disabled: busy, onClick: () => { setConfirming(false); }, children: t("confirm.no") })
					] })
				] }) : null,
				jsx("div", { className: "dsh-msel-actions", children: [
					// Armed state: the button itself shows that the click landed, so a
					// confirmation the user has not scrolled to is still not a dead end.
					// The emphasis is this plugin's own class rather than a Button
					// variant: the primitives renamed theirs (`solid` became `primary`)
					// and a destructive action must not lose its colour to that.
					jsx(primitives.Button, {
						size: "sm",
						disabled,
						className: "dsh-msel-danger",
						"data-armed": confirming ? "true" : "false",
						onClick: () => { setConfirming(true); },
						children: t("action.delete")
					}),
					actionButton(t("action.fork"), () => { void doFork(); }),
					actionButton(t("action.exportMd"), () => { void doExport("md"); }),
					actionButton(t("action.exportJson"), () => { void doExport("json"); }),
					actionButton(t("action.synthesize"), () => { void doSynthesize(); })
				] }),
				jsx("div", { className: "dsh-msel-actions", children: [
					actionButton(t("action.unread"), () => { void flag("unread")(); }),
					actionButton(t("action.read"), () => { void flag("read")(); }),
					actionButton(t("action.pin"), () => { void flag("pin")(); }),
					actionButton(t("action.unpin"), () => { void flag("unpin")(); }),
					actionButton(t("action.archive"), () => { void flag("archive")(); }),
					actionButton(t("action.unarchive"), () => { void flag("unarchive")(); })
				] }),
				busy ? jsx("div", { className: "dsh-msel-busy", children: [jsx(icons.loading, {}), t("busy.reading")] }) : null,
				jsx("div", { className: "dsh-msel-status", role: "status", "data-tone": status === null ? "info" : status.tone, children: status === null ? "" : status.text }),
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
			// own schedule, so the host may be detached or already shifted.
			row.insertBefore(host, control);
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
			const show = react.useCallback(() => {
				note("click react");
				// The injected button has now proven it can be clicked here, so the
				// footer fallback may retire (see MultiSelectEntry).
				actions.markInlineProven?.();
				hooks.panel.set({ open: true });
			}, [actions, hooks]);
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
				jsx(primitives.Modal, {
					open,
					onClose: close,
					title: t("panel.title"),
					closeLabel: t("panel.close"),
					description: t("panel.description"),
					children: open
						? jsx(PanelBoundary, {
							format: (reason) => t("error.render", { reason }),
							children: jsx(MultiSelectPanel, { t, actions, hooks, icons })
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
		 */
		function MultiSelectEntry({ t, actions, hooks, icons, tip, onTranslate }) {
			// The dialog is the same one the inline view shows: one panel store for
			// both entries means the button location never decides whether an open
			// dialog survives.
			const panel = react.useSyncExternalStore(hooks.panel.subscribe, hooks.panel.getSnapshot);
			const open = panel.open === true;
			const list = react.useSyncExternalStore(hooks.sessions.subscribe, hooks.sessions.getSnapshot);
			// Placement is another plugin-owned snapshot in the standard hook seat,
			// so the fallback button reacts without the panel being remounted.
			const placement = react.useSyncExternalStore(hooks.placement.subscribe, hooks.placement.getSnapshot);
			react.useEffect(() => {
				if (typeof onTranslate === "function") onTranslate(t);
			}, [t, onTranslate]);
			const items = snapshotItems(list);
			let total = 0;
			for (const item of items) if (item.blank !== true) total += 1;
			const close = react.useCallback(() => { hooks.panel.set({ open: false }); }, [hooks]);
			const show = react.useCallback(() => {
				// Recorded because this entry runs through the app's own React tree:
				// if it opens the panel while the injected button does not, the
				// problem is the injected DOM, not the panel.
				note("click footer");
				hooks.panel.set({ open: true });
			}, [hooks]);
			// The modal stays mounted in this view even while the button is
			// hidden, so a session opened from the inline view keeps its dialog.
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
				jsx(primitives.Modal, {
					open,
					onClose: close,
					title: t("panel.title"),
					closeLabel: t("panel.close"),
					description: t("panel.description"),
					children: open
						? jsx(PanelBoundary, {
							format: (reason) => t("error.render", { reason }),
							children: jsx(MultiSelectPanel, { t, actions, hooks, icons })
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

			const missing = REQUIRED_PRIMITIVES.filter((key) => primitives[key] === undefined);
			if (missing.length > 0) throw new Error(`session-multiselect: client-ui-primitives is missing ${missing.join(", ")}`);
			if (typeof jsx !== "function" || typeof jsxs !== "function") throw new Error("session-multiselect: react/jsx-runtime did not expose jsx/jsxs");

			// Resolved once, then handed down: which icon names this DSH ships is a
			// property of the running build, not of any one render. The ring records
			// the answer so a future rename shows up as `fallback(...)` in a report
			// instead of as a missing button.
			const resolved = resolveIcons();
			const icons = resolved.icons;
			/**
			 * Tooltips are decoration: the primitives have always shipped one, but a
			 * build without it must still get a working button.
			 */
			const tip = (label, child, side) => (typeof primitives.Tooltip === "function"
				? jsx(primitives.Tooltip, { label, delayMs: 400, ...(side === undefined ? {} : { side }), children: child })
				: child);

			const store = clientStore.defineStore({
				init: () => ({
					pinnedIds: [],
					archivedIds: [],
					unreadIds: [],
					// Set once the injected header button has been clicked in this
					// browser; the footer fallback retires on it (see MultiSelectEntry).
					inlineProven: false,
					// Grouping is the requested default; the toolbar can turn it off,
					// and the choice persists because it is a preference, not state.
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
					/** Add or remove ids from the list named by one of the three marks. */
					markMany: (draft, mode, ids) => {
						const key = mode === "unread" || mode === "read"
							? "unreadIds"
							: mode === "pin" || mode === "unpin" ? "pinnedIds" : "archivedIds";
						const adding = mode === "unread" || mode === "pin" || mode === "archive";
						const next = new Set(Array.isArray(draft[key]) ? draft[key] : []);
						for (const id of ids) {
							if (adding) next.add(id);
							else next.delete(id);
						}
						draft[key] = [...next];
					}
				}
			}).create();

			const sessions = ctx.sessions;
			const listOf = () => snapshotItems(sessions.list.getSnapshot());

			/**
			 * Read one session's history. The session is instantiated (not selected)
			 * and paged backwards; `events.entries()` is in log order.
			 */
			const readRecords = async (sessionId) => {
				const session = sessions.get(sessionId);
				await session.open();
				let pages = 0;
				while (session.getSnapshot().hasMore === true && pages < MAX_PAGES) {
					await session.loadOlder();
					pages += 1;
				}
				const events = session.events;
				return events === undefined ? [] : events.entries().map((entry) => ({ event: entry.event }));
			};

			const actions = {
				/** Read every selected session, collecting per-session failures. */
				async readTranscripts(ids, onProgress) {
					const byId = new Map(listOf().map((item) => [item.sessionId, item]));
					const entries = [];
					const failed = [];
					let done = 0;
					for (const id of ids) {
						const summary = byId.get(id) ?? { sessionId: id };
						try {
							entries.push({ summary, records: await readRecords(id) });
						} catch (error) {
							failed.push({ id, reason: failureText(error) });
							entries.push({ summary, records: [] });
						}
						done += 1;
						if (typeof onProgress === "function") onProgress(done, ids.length);
					}
					return { entries, failed };
				},
				async deleteSessions(ids) {
					let ok = 0;
					const failed = [];
					// Recorded once per batch: a missing service method is the one
					// failure whose message ("not a function") hides its own cause.
					const snapshot = sessions.list.getSnapshot();
					const known = new Set(Array.isArray(snapshot.ids) ? snapshot.ids : []);
					note("delete service", `delete=${typeof sessions.delete} ids=${String(ids.length)} listed=${String(ids.filter((id) => known.has(id)).length)} current=${String(snapshot.current ?? "")}`);
					for (const id of ids) {
						try {
							await sessions.delete(id);
							ok += 1;
						} catch (error) {
							const reason = failureText(error);
							note("delete failed", `${id.slice(0, 8)} ${reason}`);
							failed.push({ id, reason });
						}
					}
					return { ok, failed };
				},
				async forkSessions(ids) {
					let ok = 0;
					const failed = [];
					for (const id of ids) {
						try {
							await sessions.fork({ sessionId: id, increaseTitle: true });
							ok += 1;
						} catch (error) {
							failed.push({ id, reason: failureText(error) });
						}
					}
					return { ok, failed };
				},
				/**
				 * Aggregate transcripts into a brand-new session and open it, so the
				 * user lands on the comparison result rather than a silent new chat.
				 */
				async synthesize(entries) {
					const prompt = buildSynthesisPrompt(entries, SYNTHESIS_BUDGET);
					const source = entries[0] === undefined ? undefined : entries[0].summary;
					const cwd = typeof source?.cwd === "string" && source.cwd !== "" ? source.cwd : undefined;
					const target = cwd === undefined ? await sessions.create({}) : await sessions.create({ cwd });
					const session = sessions.get(target);
					await session.open();
					const result = await session.prompt([{ type: "text", text: prompt.text }], "queue");
					sessions.open(target);
					return { sessionId: target, truncated: prompt.truncated, kept: prompt.kept, accepted: result?.ok === true };
				},
				flagSessions(mode, ids) {
					store.actions.markMany(mode, ids);
				},
				/** The injected header button was clicked, so the fallback can retire. */
				markInlineProven() {
					store.actions.markInlineProven();
				}
			};

			/**
			 * Inline-placement state, shared with the footer registration through
			 * a store so hiding/showing the fallback button never remounts the
			 * panel that owns an open dialog.
			 */
			const placement = clientStore.createSnapshotStore({ inline: false });

			/**
			 * Panel visibility, owned by the plugin rather than by whichever view
			 * rendered the button. The session list re-renders the line the button
			 * hangs on, and a dialog must not disappear with the node that opened
			 * it; keeping the flag here also lets the document-level trigger below
			 * open the panel without going through a synthetic React event.
			 */
			const panel = clientStore.createSnapshotStore({ open: false });
			/** Opening is idempotent, so two triggers can race harmlessly. */
			const openPanel = () => {
				if (panel.getSnapshot().open !== true) {
					panel.set({ open: true });
					note("panel open");
				}
			};

			/**
			 * The seats the registered views read: the session list, this plugin's
			 * marks, where the inline button ended up, and whether the panel is
			 * open. One object, so both entries agree on all four.
			 */
			const hooks = {
				sessions: sessions.list,
				store,
				placement,
				panel
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
			let placed = null;

			/**
			 * Re-check inline placement on the next frame. rAF keeps a burst of
			 * mutations (React committing a subtree) to one DOM pass.
			 */
			const schedulePlacement = () => {
				if (placementFrame !== null || typeof window === "undefined") return;
				placementFrame = window.requestAnimationFrame(() => {
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
						note("click document");
						actions.markInlineProven?.();
						openPanel();
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
			/** Release on the button opens the panel, click or no click. */
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
					note("up open");
					actions.markInlineProven?.();
					openPanel();
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
			note("apply", `build=${String(BUILD)} panel=${typeof primitives.Modal === "function"} icons=${JSON.stringify(resolved.used)}`);

			schedulePlacement();

			ctx.effect(() => () => {
				for (const observer of observers) observer.disconnect();
				observers = [];
				if (placementFrame !== null && typeof window !== "undefined") window.cancelAnimationFrame(placementFrame);
				placementFrame = null;
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
					inject: () => ({
						actions,
						hooks,
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
