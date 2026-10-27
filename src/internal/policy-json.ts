/** A policy has one bounded JSON text format. */
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type * as Domain from "../Domain.ts"
import * as Json from "./json.ts"
import * as Limits from "./limits.ts"
import * as PolicyNodes from "./policy-nodes.ts"
import * as Rule from "./rule.ts"

type Node = PolicyNodes.Node

const ruleJson = (rule: Rule.Rule): unknown => ({
	_tag: rule._tag,
	actions: rule.actions,
	resources: rule.resources,
	...(rule.when === undefined ? {} : { when: Json.toJson(rule.when as never) }),
	...(rule.fields === undefined ? {} : { fields: rule.fields }),
	...(rule.reason === undefined ? {} : { reason: rule.reason }),
	...(rule.id === undefined ? {} : { id: rule.id }),
	...(rule.meta === undefined ? {} : { meta: rule.meta }),
})

/** The object form is an internal step of the text codec. */
export const toJson = (node: Node): unknown => {
	switch (node._tag) {
		case "Rules":
			return {
				_tag: node._tag,
				algorithm: node.algorithm,
				rules: Arr.map(node.rules, ruleJson),
			}
		case "All":
		case "Any":
		case "FirstOf":
			return { _tag: node._tag, policies: Arr.map(node.policies, toJson) }
		case "Ceiling":
			return {
				_tag: node._tag,
				cap: toJson(node.cap),
				policy: toJson(node.policy),
			}
	}
}

const attempt = <A>(make: () => A): Effect.Effect<A, Json.Problem> =>
	Effect.try({
		try: () => Json.at([], make),
		catch: (error) =>
			error instanceof Json.Problem ? error : Json.problem([], String(error)),
	})

export const encode = (node: Node): Effect.Effect<string, Json.Problem> =>
	attempt(() => node.pipe(toJson, Json.stringify))

const strings = (
	data: Record<string, unknown>,
	name: string,
	path: ReadonlyArray<PropertyKey>,
): ReadonlyArray<string> =>
	Arr.map(Json.readList(data, name, path), (item, index) => {
		if (typeof item !== "string") {
			throw Json.problem([...path, name, index], "The item must be a string")
		}
		return item
	})

const decodeRule = (
	input: unknown,
	domain: Domain.Any,
	path: ReadonlyArray<PropertyKey>,
): Rule.Rule =>
	Json.at(path, () => {
		const data = Json.object(input, path)
		Json.fields(
			data,
			[
				"_tag",
				"actions",
				"resources",
				"when",
				"fields",
				"reason",
				"id",
				"meta",
			],
			path,
		)
		if (data["_tag"] !== "Allow" && data["_tag"] !== "Deny") {
			throw Json.problem([...path, "_tag"], 'A rule must be "Allow" or "Deny"')
		}
		const shape: Rule.Shape = {
			_tag: data["_tag"],
			actions: strings(data, "actions", path),
			resources: strings(data, "resources", path),
			...(Object.hasOwn(data, "when")
				? { when: Json.decodeAt(data["when"], [...path, "when"]) as never }
				: {}),
			...(Object.hasOwn(data, "fields")
				? { fields: strings(data, "fields", path) }
				: {}),
			...(Object.hasOwn(data, "reason")
				? { reason: Json.readString(data, "reason", path) }
				: {}),
			...(Object.hasOwn(data, "id")
				? { id: Json.readString(data, "id", path) }
				: {}),
			...(Object.hasOwn(data, "meta")
				? { meta: data["meta"] as Schema.Json }
				: {}),
			domain,
		}
		try {
			return Rule.make(shape)
		} catch (error) {
			// The meta copier reports its path from the root of the meta value.
			if (error instanceof Json.Problem) {
				throw Json.problem([...path, "meta", ...error.path], error.message)
			}
			throw error
		}
	})

export const decode = (
	input: string,
	domain: Domain.Any,
): Effect.Effect<Node, Json.Problem> =>
	attempt(() => {
		const data = Json.parse(input)
		const count = { nodes: 0 }
		const tree = (
			value: unknown,
			path: ReadonlyArray<PropertyKey>,
			depth: number,
		): Node =>
			Json.at(path, () => {
				count.nodes += 1
				if (depth > Limits.policyDepth) {
					throw Json.problem(
						path,
						`A policy has more than ${String(Limits.policyDepth)} levels`,
					)
				}
				if (count.nodes > Limits.policyNodes) {
					throw Json.problem(
						path,
						`A policy has more than ${String(Limits.policyNodes)} units`,
					)
				}
				const current = Json.object(value, path)
				switch (current["_tag"]) {
					case "Rules": {
						Json.fields(current, ["_tag", "algorithm", "rules"], path)
						const algorithm = Json.readString(current, "algorithm", path)
						if (!PolicyNodes.isAlgorithm(algorithm)) {
							throw Json.problem(
								[...path, "algorithm"],
								`"${algorithm}" is not a combining algorithm`,
							)
						}
						const rules = Json.readList(current, "rules", path)
						if (count.nodes + rules.length > Limits.policyNodes) {
							throw Json.problem(
								path,
								`A policy has more than ${String(Limits.policyNodes)} units`,
							)
						}
						count.nodes += rules.length
						return new PolicyNodes.Rules({
							algorithm,
							rules: Arr.map(rules, (rule, index) =>
								decodeRule(rule, domain, [...path, "rules", index]),
							),
						})
					}
					case "All":
					case "Any":
					case "FirstOf": {
						Json.fields(current, ["_tag", "policies"], path)
						const policies = Json.readList(current, "policies", path)
						if (policies.length === 0) {
							throw Json.problem(
								[...path, "policies"],
								"A policy group needs at least one policy",
							)
						}
						if (count.nodes + policies.length > Limits.policyNodes) {
							throw Json.problem(
								path,
								`A policy has more than ${String(Limits.policyNodes)} units`,
							)
						}
						return new PolicyNodes[current["_tag"]](
							Arr.map(policies, (child, index) =>
								tree(child, [...path, "policies", index], depth + 1),
							),
						)
					}
					case "Ceiling":
						Json.fields(current, ["_tag", "cap", "policy"], path)
						return new PolicyNodes.Ceiling({
							cap: tree(current["cap"], [...path, "cap"], depth + 1),
							policy: tree(current["policy"], [...path, "policy"], depth + 1),
						})
					default:
						throw Json.problem([...path, "_tag"], "The policy has no known tag")
				}
			})
		return tree(data, [], 1)
	})
