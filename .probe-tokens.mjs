import { createReadStream } from "node:fs"
const path = "D:\\deepseek harness\\resources\\app.asar"
const names = new Map()
const pattern = /--dsw-(alias|static)-[a-z0-9-]+/g
let carry = ""
for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) {
  const text = carry + chunk.toString("latin1")
  let m
  while ((m = pattern.exec(text)) !== null) names.set(m[0], (names.get(m[0]) ?? 0) + 1)
  carry = text.slice(-64)
  pattern.lastIndex = 0
}
const bg = [...names.entries()].filter(([name]) => /bg|surface|layer|elevat/.test(name)).sort((a, b) => b[1] - a[1])
console.log("background-ish tokens:")
for (const [name, count] of bg.slice(0, 30)) console.log(`  ${String(count).padStart(5)}  ${name}`)
console.log("\nlabel/border tokens:")
for (const [name, count] of [...names.entries()].filter(([n]) => /label|border/.test(n)).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${String(count).padStart(5)}  ${name}`)
