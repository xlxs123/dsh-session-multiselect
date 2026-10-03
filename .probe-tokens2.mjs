import { createReadStream } from "node:fs"
const path = "D:\\deepseek harness\\resources\\app.asar"
const names = new Map()
const pattern = /--dsw-[a-z0-9-]+/g
let carry = ""
for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) {
  const text = carry + chunk.toString("latin1")
  let m
  while ((m = pattern.exec(text)) !== null) names.set(m[0], (names.get(m[0]) ?? 0) + 1)
  carry = text.slice(-64)
  pattern.lastIndex = 0
}
for (const [name, count] of [...names.entries()].filter(([n]) => /state-|business|error|hover-solid|radius-xl|static-neutral/.test(n)).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(count).padStart(5)}  ${name}`)
console.log("total distinct tokens:", names.size)
