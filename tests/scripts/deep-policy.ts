// Decodes a deep policy tree with very many rules. A test runs this file in a
// Node.js process with a small heap, so a decoder that keeps a full copy of
// the path of each rule runs out of memory.
import { Array as Arr, Exit, Schema } from "effect"
import { Policy } from "../../src/index.ts"
import { App } from "../fixtures.ts"

const rules = Arr.makeBy(30_000, () => ({
	_tag: "Allow",
	actions: ["read"],
	resources: ["Bot"],
}))
const input = Arr.reduce(
	Arr.range(1, 250),
	{ _tag: "Rules", algorithm: "denyOverrides", rules } as unknown,
	(inner) => ({ _tag: "All", policies: [inner] }),
)
const exit = Schema.decodeUnknownExit(Policy.schema(App))(input)
console.log(Exit.isSuccess(exit) ? "decoded" : "failed")
