/**
 * Read the plugin's diagnostic ring out of the DSH Desktop app's session
 * storage.
 *
 * The browser bundle keeps a bounded event ring in `sessionStorage` (see
 * `note()` in lib/client.js). When the GUI misbehaves in a way the user cannot
 * describe and there is no devtools access, that ring is the only witness: it
 * says whether a click reached the plugin, whether a panel opened, and what an
 * error said — or, when nothing at all was written, that the bundle never ran.
 *
 * Chromium writes session storage as LevelDB: the key is stored as bytes and the
 * value as UTF-16LE. Both encodings are tried, the JSON array is found by
 * bracket matching (a value can sit next to record boundaries, so slicing to the
 * last `"]` in a window is not enough), and every file is scanned newest first —
 * a store keeps one record per origin, and the GUI's port changes between
 * versions.
 *
 * Run: node tests/browser/read-diag.mjs
 * (Override the profile with DSH_APP_DATA=<dir>.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the desktop app keeps its Chromium profile, on any platform. */
function defaultAppData() {
	if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop')
	if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dsh-desktop')
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dsh-desktop')
}

const appData = process.env.DSH_APP_DATA ?? defaultAppData()
const storageDir = join(appData, 'Session Storage')
const KEY = 'dsh.session.multiselect.diag'

/** Every file in the store, newest first (a directory tree, leveldb included). */
function storeFiles(directory) {
	const found = []
	const walk = (path) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name)
			if (entry.isDirectory()) walk(full)
			else found.push(full)
		}
	}
	walk(directory)
	return found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
}

/**
 * The ring inside one decoded string, or null.
 *
 * Walks the JSON array to its matching bracket and insists the result looks like
 * notes (an array of strings), so a partial neighbouring record cannot be
 * mistaken for a trail.
 */
function parseRing(text) {
	const start = text.indexOf('[')
	if (start === -1 || start > 16) return null
	let depth = 0
	for (let index = start; index < text.length; index += 1) {
		if (text[index] === '[') depth += 1
		else if (text[index] === ']') {
			depth -= 1
			if (depth !== 0) continue
			try {
				const parsed = JSON.parse(text.slice(start, index + 1))
				if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((note) => typeof note === 'string')) return parsed
			} catch {
				/* mid-record: the caller tries the next occurrence */
			}
			return null
		}
	}
	return null
}

/**
 * Decode a range of a buffer as UTF-16LE, by hand.
 *
 * Deliberately not `buffer.toString('utf16le')`: on the Node this was written
 * against (24.9.0, Windows) a few dozen `Buffer#toString` calls over multi-KB
 * ranges corrupt the process heap (`STATUS_HEAP_CORRUPTION`, exit -1073740940),
 * which is what made this reader report "no record found" for a store that did
 * hold one. Reading the bytes directly has no such problem.
 * @param buffer - the file contents.
 * @param from - byte offset of the first UTF-16 code unit.
 * @returns the decoded text.
 */
function decodeUtf16(buffer, from) {
	const parts = []
	const step = 2048
	for (let index = from; index + 1 < buffer.length; index += step * 2) {
		const stop = Math.min(index + step * 2, buffer.length - ((buffer.length - index) % 2));
		const units = []
		for (let at = index; at + 1 < stop; at += 2) units.push(buffer[at] | (buffer[at + 1] << 8))
		if (units.length === 0) break
		parts.push(String.fromCharCode(...units))
	}
	return parts.join('')
}

/**
 * Every ring this store holds, newest write first.
 *
 * The key is stored as bytes and the value as UTF-16LE, so a UTF-16 `[` is the
 * byte pair `5B 00`: the array start is found in the byte view, and only that
 * slice is decoded.
 */
function readTrails(directory) {
	const trails = []
	const needle = Buffer.from(KEY, 'utf8')
	for (const file of storeFiles(directory)) {
		const buffer = readFileSync(file)
		let at = buffer.indexOf(needle)
		while (at !== -1) {
			const from = at + needle.length
			let start = -1
			for (let index = from; index + 1 < Math.min(from + 512, buffer.length); index += 1) {
				if (buffer[index] === 0x5b && buffer[index + 1] === 0x00) {
					start = index
					break
				}
			}
			if (start !== -1) {
				const notes = parseRing(decodeUtf16(buffer, start))
				if (notes !== null) trails.push({ file, mtime: statSync(file).mtime, notes })
			}
			at = buffer.indexOf(needle, from)
		}
	}
	return trails
}

let trails
try {
	trails = readTrails(storageDir)
} catch (error) {
	console.log(`cannot read ${storageDir}: ${error.message}`)
	process.exit(1)
}

if (trails.length === 0) {
	console.log(`no '${KEY}' record found under ${storageDir}`)
	console.log('Nothing was written at all — which is itself the diagnosis: the client bundle never ran.')
	console.log('(Check that the plugin is installed in the profile the app boots: `dsh plugin --profile <name> list`.)')
} else {
	console.log(`${trails.length} record(s) found; newest first:\n`)
	for (const trail of trails.slice(0, 3)) {
		console.log(`--- ${trail.file.split(/[\\/]/).pop()} (${trail.mtime.toISOString()}) — ${trail.notes.length} notes ---`)
		for (const note of trail.notes) console.log(`  ${note}`)
		console.log('')
	}
}
