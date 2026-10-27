/** The condition codec checks names and types against one resource. */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as Domain from "../Domain.ts"
import * as Bind from "./bind.ts"
import * as Json from "./json.ts"
import * as Nodes from "./nodes.ts"

export const schema = (
	domain: Domain.Any,
	kind: string,
): Schema.Codec<Nodes.Node, string> => {
	const bound = (node: Nodes.Node): Nodes.Node => {
		const found = Bind.conditionIssues(domain, kind, node)[0]
		if (found !== undefined) {
			throw Json.problem(found.path, found.issue)
		}
		return Nodes.bind(node, domain, kind)
	}
	const plain = Schema.declare(
		(input): input is Nodes.Node => Nodes.isNode(input) && !input.opaque,
	)
	return Schema.String.pipe(
		Schema.decodeTo(
			plain,
			SchemaTransformation.transformEffect({
				decode: (input, options) =>
					Effect.try({
						try: () => bound(Json.decodeAt(Json.parse(input))),
						catch: (error) => {
							const problem =
								error instanceof Json.Problem
									? error
									: Json.problem([], String(error))
							return new SchemaIssue.Pointer(
								problem.path,
								new SchemaIssue.InvalidValue(
									{ message: problem.message },
									input,
									options,
								),
							)
						},
					}),
				encode: (condition, options) =>
					Effect.try({
						try: () => condition.pipe(bound, Json.encode),
						catch: (error) => {
							const problem =
								error instanceof Json.Problem
									? error
									: Json.problem([], String(error))
							return new SchemaIssue.Pointer(
								problem.path,
								new SchemaIssue.InvalidValue(
									{ message: problem.message },
									condition,
									options,
								),
							)
						},
					}),
			}),
		),
	)
}
