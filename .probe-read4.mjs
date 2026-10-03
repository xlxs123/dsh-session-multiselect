import { readFileSync } from "node:fs"
import { join } from "node:path"
const dir = join(process.env.APPDATA, "dsh-desktop", "Session Storage")
const buffer = readFileSync(join(dir, "000005.ldb"))
console.log("bytes", buffer.length)
for (let i = 0; i < 40; i += 1) {
  const slice = buffer.subarray(i)
  const a = slice.toString("utf16le").length
  const b = slice.toString("utf8").length
  process.stdout.write(`${i}:${a}/${b} `)
}
console.log("\nstep1 ok")
for (let i = 0; i < 200; i += 1) {
  const slice = buffer.subarray(1000 + i)
  slice.toString("utf16le")
  slice.toString("utf8")
}
console.log("step2 ok")
