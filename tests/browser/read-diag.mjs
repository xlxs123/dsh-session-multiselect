/**
 * Read the plugin's diagnostic ring out of the DSH Desktop app's session
 * storage.
 *
 * The browser bundle keeps a bounded event ring in `sessionStorage` (see
 * `note()` in lib/client.js). When the GUI misbehaves in a way the user cannot
 * describe and there is no devtools access, that ring is the only witness: it
 * says whether a click reached the plugin, whether the panel opened, and what
 * an error said.
 *
 * Chromium writes session storage as UTF-16LE records in a LevelDB log, so the
 * value is recovered by scanning the file's UTF-16 view for the key and then
 * decoding the JSON array that follows it.
 *
 * Run: node tests/browser/read-diag.mjs
 * (Override the profile with DSH_APP_DATA=<dir>.)
 */
import { readdirSync, readFileSync } from 'node:fs'
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

/** Every trail written in the log, oldest first. */
function readTrails(directory) {
	const trails = []
	let files
	try {
		files = readdirSync(directory).filter((name) => name.endsWith('.log') || name.endsWith('.ldb'))
	} catch (error) {
		throw new Error(`cannot list ${directory}: ${error.message}`)
	}
	for (const name of files) {
		const buffer = readFileSync(join(directory, name))
		// Chromium writes the key as single bytes and the value as UTF-16LE, so
		// the key is located in the latin1 view and the value decoded after it.
		const latin = buffer.toString('latin1')
		let from = 0
		for (;;) {
			const at = latin.indexOf(KEY, from)
			if (at === -1) break
			from = at + KEY.length
			// Try both byte alignments: one of them starts the UTF-16 value.
			for (const offset of [from, from + 1]) {
				const window = buffer.subarray(offset, offset + 8192).toString('utf16le')
				const start = window.indexOf('[')
				const end = window.lastIndexOf('"]')
				if (start === -1 || end < start) continue
				try {
					const parsed = JSON.parse(window.slice(start, end + 2))
					if (Array.isArray(parsed) && parsed.length > 0) {
						trails.push({ file: name, notes: parsed })
						break
					}
				} catch {
					/* a partial record: the newest write may be mid-file */
				}
			}
		}
	}
	return trails
}

const trails = readTrails(storageDir)
if (trails.length === 0) {
	console.log(`no '${KEY}' record found in ${storageDir}`)
	console.log('(refresh the GUI, click the entry button once, then run this again)')
} else {
	const latest = trails.at(-1)
	console.log(`${trails.length} record(s) found; newest is in ${latest.file}:`)
	for (const note of latest.notes) console.log(`  ${note}`)
}
