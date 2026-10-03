import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
const dir = join(process.env.APPDATA, "dsh-desktop", "Session Storage")
const files = readdirSync(dir).map((name) => join(dir, name)).filter((path) => statSync(path).isFile())
console.log("files:", files.length)
for (const file of files) {
  const size = statSync(file).size
  process.stdout.write(`${file.split(/[\\/]/).pop()} ${size}B ... `)
  try {
    const buffer = readFileSync(file)
    process.stdout.write(`read ${buffer.length}, latin1 ${buffer.toString("latin1").length}, utf16 ${buffer.toString("utf16le").length}\n`)
  } catch (error) {
    process.stdout.write(`FAILED ${String(error)}\n`)
  }
}
console.log("done")
