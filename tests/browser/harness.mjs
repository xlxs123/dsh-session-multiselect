/**
 * Browser smoke test for the header injection.
 *
 * The Node suites drive the bundle against DOM and React stand-ins, which can
 * prove placement math but not that a real click on a real button in a real
 * layout opens the dialog. This runner serves `click.html`, the real React 18
 * UMD builds from the desktop app's own dependency tree, and the shipped
 * bundle, then drives headless Chrome over CDP and asserts what a user would
 * see: where the button lands, what is on top of it, and whether clicking it
 * opens the panel.
 *
 * Run: node tests/browser/harness.mjs
 * (Overridable: SMOKE_BROWSER, SMOKE_PORT, SMOKE_CDP_PORT, SMOKE_KEEP_BROWSER=1,
 *  SMOKE_APP_NODE_MODULES — a `resources/app/node_modules` to take React from.)
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..', '..')
const browserPath = process.env.SMOKE_BROWSER ?? defaultBrowser()
const httpPort = Number(process.env.SMOKE_PORT ?? 8791)
const cdpPort = Number(process.env.SMOKE_CDP_PORT ?? 9223)
const cdpOrigin = `http://127.0.0.1:${cdpPort}`

/** A Chromium to drive: whatever is installed, whoever is running the suite. */
function defaultBrowser() {
	const candidates = process.platform === 'win32'
		? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
		: process.platform === 'darwin'
			? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
			: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
	return candidates.find((path) => existsSync(path)) ?? candidates[0]
}

/**
 * Locate the React 18 UMD builds the page loads.
 *
 * They come from a real installation rather than from this package, because the
 * bundle under test is written against the exact React the desktop app ships.
 * The app's own `node_modules` is the truest source, so it is searched first and
 * a plain `npm install` of this package's devDependencies is the fallback.
 * @returns the directory holding `react/umd` and `react-dom/umd`.
 * @throws when neither exists, naming the two ways to provide one.
 */
function findReactRoot() {
	const localAppData = process.env.LOCALAPPDATA ?? ''
	const candidates = [
		process.env.SMOKE_APP_NODE_MODULES,
		process.env.DSH_APP_NODE_MODULES,
		join(pluginRoot, 'node_modules'),
		localAppData === '' ? undefined : join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules'),
		localAppData === '' ? undefined : join(localAppData, 'Programs', 'dsh-desktop', 'resources', 'app', 'node_modules'),
		'/Applications/DSH Desktop.app/Contents/Resources/app/node_modules',
		join(homedir(), '.local', 'share', 'dsh-desktop', 'resources', 'app', 'node_modules')
	].filter((candidate) => candidate !== undefined)
	for (const root of candidates) {
		if (existsSync(join(root, 'react', 'umd', 'react.development.js')) && existsSync(join(root, 'react-dom', 'umd', 'react-dom.development.js'))) return root
	}
	throw new Error(
		'React 18 UMD builds not found. Either run `npm install` in this package '
		+ '(react + react-dom are devDependencies), or point SMOKE_APP_NODE_MODULES at a '
		+ 'DSH Desktop `resources/app/node_modules` directory.'
	)
}

const MIME = new Map([
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.mjs', 'text/javascript; charset=utf-8'],
	['.css', 'text/css; charset=utf-8']
])

// --- static server: the plugin under test plus the real React builds --------

const reactRoot = findReactRoot()
const mounts = [
	['/plugin/', pluginRoot],
	['/react/', join(reactRoot, 'react', 'umd')],
	['/react-dom/', join(reactRoot, 'react-dom', 'umd')]
]

/** Resolve a request path against the mounts, refusing traversal. */
function resolveRequest(pathname) {
	for (const [prefix, root] of mounts) {
		if (!pathname.startsWith(prefix)) continue
		const target = resolve(join(root, normalize(pathname.slice(prefix.length))))
		if (target !== root && !target.startsWith(root)) return null
		return target
	}
	return null
}

function startServer() {
	const server = createServer(async (request, response) => {
		const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
		const file = resolveRequest(pathname)
		if (file === null) {
			response.writeHead(404).end('not mounted')
			return
		}
		try {
			const body = await readFile(file)
			response.writeHead(200, { 'content-type': MIME.get(extname(file)) ?? 'application/octet-stream' })
			response.end(body)
		} catch {
			response.writeHead(404).end('not found')
		}
	})
	return new Promise((ready) => server.listen(httpPort, '127.0.0.1', () => ready(server)))
}

// --- headless browser -------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Minimal CDP client over the global WebSocket. */
function makeClient(wsUrl) {
	const socket = new WebSocket(wsUrl)
	const pending = new Map()
	const console_ = []
	let nextId = 0
	const ready = new Promise((resolveReady, rejectReady) => {
		socket.addEventListener('open', () => resolveReady())
		socket.addEventListener('error', (event) => rejectReady(new Error(`CDP socket error: ${event.message ?? 'unknown'}`)))
	})
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data)
		if (message.id === undefined) {
			if (message.method === 'Runtime.consoleAPICalled') {
				console_.push(`${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')}`)
			}
			if (message.method === 'Runtime.exceptionThrown') {
				console_.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
			}
			return
		}
		const slot = pending.get(message.id)
		pending.delete(message.id)
		if (message.error !== undefined) slot.reject(new Error(`${slot.method}: ${message.error.message}`))
		else slot.resolve(message.result)
	})
	const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
		nextId += 1
		pending.set(nextId, { resolve: resolveSend, reject: rejectSend, method })
		socket.send(JSON.stringify({ id: nextId, method, params }))
	})
	return { ready, send, console: console_, close: () => socket.close() }
}

/** Create a target for `url` and resolve its CDP socket URL. */
async function openTarget(url) {
	const created = await fetch(`${cdpOrigin}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
	if (!created.ok) throw new Error(`could not open a target: ${created.status}`)
	return created.json()
}

/**
 * Is the browser on the CDP port actually usable?
 *
 * `/json/version` answers while a browser is still shutting down, and a browser
 * that dies mid-run destroys the page's execution context — which surfaces as
 * "Execution context was destroyed" rather than as a missing browser. So the
 * probe opens a real target and evaluates something in it.
 * @returns `true` only when a page round-trips a value.
 */
async function browserIsHealthy() {
	try {
		const probe = await fetch(`${cdpOrigin}/json/version`)
		if (!probe.ok) return false
		const target = await openTarget('about:blank')
		const client = makeClient(target.webSocketDebuggerUrl)
		await client.ready
		await client.send('Runtime.enable')
		const reply = await client.send('Runtime.evaluate', { expression: '41 + 1', returnByValue: true })
		client.close()
		await fetch(`${cdpOrigin}/json/close/${target.id}`).catch(() => {})
		return reply.result?.value === 42
	} catch {
		return false
	}
}

/** Reuse a browser already listening on the CDP port *and still alive*, or start one. */
async function ensureBrowser() {
	if (await browserIsHealthy()) return { spawned: null, profile: null }
	const profile = join(tmpdir(), `smoke-${randomUUID().slice(0, 8)}`)
	const child = spawn(browserPath, [
		'--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
		'--disable-background-timer-throttling', '--disable-renderer-backgrounding',
		'--allow-file-access-from-files', `--user-data-dir=${profile}`,
		`--remote-debugging-port=${cdpPort}`, 'about:blank'
	], { detached: true, stdio: 'ignore' })
	child.unref()
	for (let attempt = 0; attempt < 60; attempt += 1) {
		await sleep(250)
		if (await browserIsHealthy()) return { spawned: child, profile }
	}
	throw new Error(`headless browser never exposed a usable CDP target on ${cdpOrigin}`)
}

// --- run --------------------------------------------------------------------

const server = await startServer()
const { spawned, profile } = await ensureBrowser()
const pageUrl = `http://127.0.0.1:${httpPort}/plugin/tests/browser/click.html`

const poll = `new Promise((done) => {
	const started = Date.now();
	const tick = () => {
		const verdict = document.getElementById('verdict');
		if (verdict !== null) { done(verdict.textContent); return; }
		if (Date.now() - started > 10000) { done('TIMEOUT ' + document.body.innerHTML.slice(0, 600)); return; }
		setTimeout(tick, 100);
	};
	tick();
})`

/**
 * Open the page and wait for its verdict.
 *
 * The page is opened per attempt: a context can be destroyed between the
 * target's creation and the first evaluation (a browser finishing its startup
 * or shutdown does exactly that), and retrying on the same dead target would
 * only reproduce the failure.
 * @returns the verdict text.
 */
async function collectVerdict() {
	const target = await openTarget(pageUrl)
	const client = makeClient(target.webSocketDebuggerUrl)
	await client.ready
	await client.send('Runtime.enable')
	try {
		const evaluated = await client.send('Runtime.evaluate', { expression: poll, awaitPromise: true, returnByValue: true })
		for (const line of client.console) console.log(`  browser: ${line}`)
		return evaluated.result?.value ?? ''
	} finally {
		client.close()
	}
}

let verdict = null
let failure = null
try {
	let text = ''
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			text = await collectVerdict()
			break
		} catch (error) {
			if (attempt === 1 || !/context was destroyed|Target closed|Session with given id/iu.test(error.message)) throw error
			await sleep(500)
		}
	}
	if (!text.startsWith('{')) throw new Error(`the page never produced a verdict: ${text}`)
	verdict = JSON.parse(text)
} catch (error) {
	failure = error
}

const checks = verdict === null ? [] : [
	['the injected host is attached to the search line', verdict.hostAttached === true],
	['the entry button is rendered', verdict.buttonRendered === true],
	['the button is a 28px box, like the native icons', verdict.buttonBoxWidth === 28],
	[
		`the host carries the drag-region opt-out (${verdict.hostAppRegion}) and a stacking order (z-index ${verdict.hostZIndex})`,
		verdict.hostAppRegion === 'no-drag' && verdict.hostZIndex === '5'
	],
	[
		`the gap to the magnifier equals the native icon gap (${verdict.gapToMagnifier}px vs ${verdict.nativeGapMagnifierToAction}px)`,
		verdict.gapToMagnifier === verdict.nativeGapMagnifierToAction
	],
	[`the button is the topmost element at its own centre (found ${verdict.elementFromPoint})`, verdict.hitTestReachesButton === true],
	['a real click opens the panel', verdict.modalAfterClick === true],
	[
		`the panel heads one group per workspace (${(verdict.groupHeadings ?? []).map((name) => JSON.stringify(name)).join(' | ')})`,
		Array.isArray(verdict.groupHeadings)
			&& verdict.groupHeadings.length === 3
			&& verdict.groupHeadings[0] === 'D:/work/alpha'
			&& verdict.groupHeadings[1] === 'D:/work/beta'
			&& verdict.groupHeadings[2] !== 'D:/work/beta'
	],
	[
		`and paints each row under its own heading (${(verdict.rowTitles ?? []).join(' / ')})`,
		JSON.stringify(verdict.rowTitles) === JSON.stringify(['第一个对话', '第二个对话', '第三个对话', '没有工作区的对话'])
			&& JSON.stringify(verdict.rowsPerHeading) === JSON.stringify([2, 1, 1])
	],
	[
		`one click on a heading takes the whole workspace (${JSON.stringify(verdict.selectedAfterGroupClick)})`,
		JSON.stringify(verdict.selectedAfterGroupClick) === JSON.stringify(['true', 'true', 'false', 'false'])
	],
	['the mask closes it again', verdict.modalClosedAgain === true],
	['a click dispatched at the button centre opens the panel', verdict.modalAfterDispatchedClick === true],
	[
		`the panel listed the sessions from the controller's snapshot (${(verdict.diagTrail ?? []).length} notes)`,
		Array.isArray(verdict.diagTrail)
			&& verdict.diagTrail.some((line) => line.includes('click'))
			&& verdict.diagTrail.some((line) => line.includes('panel open'))
			&& verdict.diagTrail.some((line) => line.includes('panel rendered rows=4'))
	],
	['the page reported no errors', (verdict.errors ?? []).length === 0]
]

console.log(`page:    ${pageUrl}`)
console.log(`browser: ${browserPath}`)
if (verdict !== null) console.log(`verdict: ${JSON.stringify(verdict)}`)
if (failure !== null) console.log(`FAILED to collect a verdict: ${failure.message}`)

let failed = failure !== null
for (const [label, ok] of checks) {
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
	if (!ok) failed = true
}

server.close()
if (spawned !== null && process.env.SMOKE_KEEP_BROWSER !== '1') {
	spawned.kill()
	// Wait for the port to stop answering before exiting. A browser that is still
	// shutting down looks alive to the next run's probe, and reusing it is how a
	// run used to die with "Execution context was destroyed" on a page that was
	// perfectly fine.
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await sleep(250)
		if (!(await browserIsHealthy())) break
	}
}
if (profile !== null && process.env.SMOKE_KEEP_BROWSER !== '1') {
	const { rm } = await import('node:fs/promises')
	await rm(profile, { recursive: true, force: true }).catch(() => {})
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exit(failed ? 1 : 0)
