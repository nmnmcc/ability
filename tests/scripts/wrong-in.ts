// Decodes a policy with one `In` test of 500,000 numbers on a string field.
// Each value is wrong. A test runs this file in a Node.js process with a
// small heap, so a binding that made an issue for each value before it cut
// the list to the most issues runs out of memory.
import { Array as Arr, Exit, Schema } from "effect"
import { Policy } from "../../src/index.ts"
import { App } from "../fixtures.ts"

const input = {
	_tag: "Rules",
	algorithm: "denyOverrides",
	rules: [
		{
			_tag: "Allow",
			actions: ["read"],
			resources: ["Bot"],
			when: {
				_tag: "In",
				field: "name",
				values: Arr.makeBy(500_000, (index) => ({
					_tag: "Literal",
					value: index,
				})),
			},
		},
	],
}
const exit = Schema.decodeUnknownExit(Policy.schema(App))(input)
console.log(Exit.isFailure(exit) && !Exit.hasDies(exit) ? "failed" : "decoded")
