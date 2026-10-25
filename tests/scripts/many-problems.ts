// Decodes a deep policy tree with one rule that has very many wrong fields.
// A test runs this file in a Node.js process with a small heap, so a binding
// that makes the full path of each problem runs out of memory.
import { Array as Arr, Exit, Schema } from "effect"
import { Policy } from "../../src/index.ts"
import { App } from "../fixtures.ts"

const rule = {
	_tag: "Allow",
	actions: ["read"],
	resources: ["Bot"],
	fields: Arr.makeBy(100_000, (index) => `missing${String(index)}`),
}
const input = Arr.reduce(
	Arr.range(1, 250),
	{ _tag: "Rules", algorithm: "denyOverrides", rules: [rule] } as unknown,
	(inner) => ({ _tag: "All", policies: [inner] }),
)
const exit = Schema.decodeUnknownExit(Policy.schema(App))(input)
console.log(Exit.isFailure(exit) ? "failed" : "decoded")
