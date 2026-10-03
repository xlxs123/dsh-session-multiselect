import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
const KEY = "dsh.session.multiselect.diag"
const dir = join(process.env.APPDATA, "dsh-desktop", "Session Storage")
const files = readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isFile())
const sorted = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
console.log("phase1 ok", sorted.length)
const hits = []
for (const file of sorted) {
  const buffer = readFileSync(file)
  for (const needle of [Buffer.from(KEY, "utf16le"), Buffer.from(KEY, "utf8")]) {
    let at = buffer.indexOf(needle)
    while (at !== -1) { hits.push([file, at + needle.length]); at = buffer.indexOf(needle, at + needle.length) }
  }
}
console.log("phase2 ok hits:", hits.length)
let parsed = 0
for (const [file, from] of hits) {
  const buffer = readFileSync(file)
  for (const encoding of ["utf16le", "utf8"]) {
    for (let delta = 0; delta <= 4; delta += 1) {
      const text = buffer.subarray(from + delta).toString(encoding)
      const start = text.indexOf("[")
      if (start === -1 || start > 16) continue
      let depth = 0
      for (let i = start; i < text.length; i += 1) {
        if (text[i] === "[") depth += 1
        else if (text[i] === "]") {
          depth -= 1
          if (depth !== 0) continue
          try {
            const value = JSON.parse(text.slice(start, i + 1))
            if (Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "string")) { parsed += 1; console.log("parsed ring with", value.length, "notes from", file.split(/[\\/]/).pop(), encoding, "delta", delta); console.log("  first:", value[0]); console.log("  last:", value.at(-1)) }
          } catch {}
          break
        }
      }
    }
  }
}
console.log("phase3 ok parsed:", parsed)
