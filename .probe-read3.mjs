import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
const KEY = "dsh.session.multiselect.diag"
const dir = join(process.env.APPDATA, "dsh-desktop", "Session Storage")
const files = readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isFile())
let decodes = 0
let parses = 0
const rings = []
for (const file of files) {
  const buffer = readFileSync(file)
  for (const needle of [Buffer.from(KEY, "utf16le"), Buffer.from(KEY, "utf8")]) {
    let at = buffer.indexOf(needle)
    while (at !== -1) {
      const from = at + needle.length
      for (const encoding of ["utf16le", "utf8"]) {
        for (let delta = 0; delta <= 4; delta += 1) {
          const text = buffer.subarray(from + delta).toString(encoding)
          decodes += 1
          const start = text.indexOf("[")
          if (start === -1 || start > 16) continue
          parses += 1
          const end = text.indexOf("]", start)
          if (end === -1) continue
          rings.push({ file: file.split(/[\\/]/).pop(), slice: text.slice(start, end + 1) })
        }
      }
      at = buffer.indexOf(needle, at + needle.length)
    }
  }
}
console.log("decodes", decodes, "parses", parses, "rings", rings.length)
let ok = 0
for (const ring of rings) {
  try { const value = JSON.parse(ring.slice); if (Array.isArray(value)) ok += 1 } catch {}
}
console.log("json ok", ok)
console.log("sample length", rings.length > 0 ? rings[0].slice.length : 0)
