/** A condition builder tied to one domain and kind. */
// Predicate error and service types are kept by the public signature.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import { hasProperty } from "effect/Predicate"
import type * as Domain from "../Domain.ts"
import * as Bind from "./bind.ts"
import * as Nodes from "./nodes.ts"

/** Internal rules use `*` until their full target list is bound. */
export const make = (domain: Domain.Any, kind: string) => {
	const operand = (value: unknown): Nodes.Operand => {
		if (
			hasProperty(value, "_tag") &&
			(value._tag === "Literal" || value._tag === "Principal")
		) {
			const input = value as Nodes.Operand
			if (input._tag === "Principal") {
				const owner = Nodes.principalDomainOf(input)
				if (owner !== undefined && owner !== domain)
					throw new Error("A principal field belongs to another domain")
			}
			return input
		}
		return Nodes.literal(value as Nodes.Scalar)
	}
	const operands = (
		values: ReadonlyArray<unknown>,
	): ReadonlyArray<Nodes.Operand> => Arr.map(values, operand)
	const origin = { domain, kind }
	const bound = (node: Nodes.Node): Nodes.Node => {
		const issues = kind === "*" ? [] : Bind.conditionIssues(domain, kind, node)
		const issue = issues[0]
		if (issue !== undefined)
			throw new Error(`${issue.path.join(".")}: ${issue.issue}`)
		return Nodes.bind(node, domain, kind)
	}
	const compare =
		(op: Nodes.CompareOperator) => (field: string, value: unknown) =>
			bound(new Nodes.Compare({ op, field, value: operand(value) }, origin))
	return {
		eq: compare("eq"),
		ne: compare("ne"),
		lt: compare("lt"),
		lte: compare("lte"),
		gt: compare("gt"),
		gte: compare("gte"),
		in: (field: string, values: ReadonlyArray<unknown>) =>
			bound(new Nodes.In({ field, values: operands(values) }, origin)),
		exists: (field: string) => bound(new Nodes.Exists({ field }, origin)),
		under: (...prefix: ReadonlyArray<unknown>) =>
			bound(new Nodes.Under({ prefix: operands(prefix) }, origin)),
		principal: (path: string) => Nodes.principalRef(path, domain),
		and: (...conditions: ReadonlyArray<Nodes.Node>) =>
			bound(new Nodes.And(conditions)),
		or: (...conditions: ReadonlyArray<Nodes.Node>) =>
			bound(new Nodes.Or(conditions)),
		not: (condition: Nodes.Node) => bound(new Nodes.Not(condition)),
		predicate: (
			name: string,
			test: (
				value: unknown,
				principal: unknown,
			) => boolean | Effect.Effect<boolean, unknown, unknown>,
		) =>
			bound(
				new Nodes.Predicate({
					name,
					run: (value, principal) =>
						Effect.suspend(() => {
							const result = test(value, principal)
							return Effect.isEffect(result) ? result : Effect.succeed(result)
						}),
				}),
			),
	}
}
