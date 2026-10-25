// Makes a domain with a field of a union that holds one union in two
// places, 25 levels down: 26 Schema nodes, but 33,554,432 paths to a string.
// A test runs this file in a Node.js process with a small heap, so a walk
// that opened the union again at each place runs out of memory.
import { Array as Arr, Schema } from "effect"
import { Domain, Resource } from "../../src/index.ts"
import { Caller } from "../fixtures.ts"

const Shared = Arr.reduce(
	Arr.range(1, 25),
	Schema.String as Schema.Top,
	(inner) => Schema.Union([inner, inner]),
)
const Note = Resource.make("Note", {
	actions: ["read"],
	fields: { text: Shared as typeof Schema.String },
})
Domain.make({
	principal: Caller,
	resources: [Note],
	limits: { catalogFields: 10 },
})
console.log("made")
