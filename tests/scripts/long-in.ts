// Decodes a policy with one `In` test of 700,000 values, for a domain that
// takes only 2 nodes and values in a condition, or only 2 nodes in a policy:
// the first argument names the limit. A test runs this file in a Node.js
// process with a small heap, so a decoder that read every value before it
// checked the limit runs out of memory.
import { Array as Arr, Exit, Schema } from "effect"
import { Domain, Policy } from "../../src/index.ts"
import { Bot, Caller } from "../fixtures.ts"

const Small = Domain.make({
	principal: Caller,
	resources: [Bot],
	limits: {
		[process.argv[2] === "policyNodes" ? "policyNodes" : "conditionNodes"]: 2,
	},
})
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
				values: Arr.makeBy(700_000, (index) => ({
					_tag: "Literal",
					value: `n${String(index)}`,
				})),
			},
		},
	],
}
const exit = Schema.decodeUnknownExit(Policy.schema(Small))(input)
console.log(Exit.isFailure(exit) && !Exit.hasDies(exit) ? "failed" : "decoded")
