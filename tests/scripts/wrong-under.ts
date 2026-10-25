// Decodes a policy with one `Under` test of 500,000 parts, each a field of
// the principal that the principal does not have. A test runs this file in
// a Node.js process with a small heap, so a binding that made an issue for
// each part before it cut the list to the most issues runs out of memory.
import { Array as Arr, Exit, Schema } from "effect"
import { Domain, Policy, Resource } from "../../src/index.ts"

const Folder = Resource.make("Folder", {
	actions: ["read"],
	fields: { key: Schema.String },
	path: (fields) => [fields.key],
})
const Folders = Domain.make({
	principal: Schema.Struct({ id: Schema.String }),
	resources: [Folder],
})
const input = {
	_tag: "Rules",
	algorithm: "denyOverrides",
	rules: [
		{
			_tag: "Allow",
			actions: ["read"],
			resources: ["Folder"],
			when: {
				_tag: "Under",
				prefix: Arr.makeBy(500_000, () => ({
					_tag: "Principal",
					path: "missing",
				})),
			},
		},
	],
}
const exit = Schema.decodeUnknownExit(Policy.schema(Folders))(input)
console.log(Exit.isFailure(exit) && !Exit.hasDies(exit) ? "failed" : "decoded")
