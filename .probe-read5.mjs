const buffer = Buffer.alloc(14552, 65)
for (let i = 0; i < 400; i += 1) {
  const slice = buffer.subarray(i)
  slice.toString("utf16le")
  slice.toString("utf8")
}
console.log("pure memory ok")
const big = Buffer.alloc(200 * 1024 * 1024, 66)
for (let i = 0; i < 4; i += 1) big.subarray(i).toString("utf8").length
console.log("big ok")
