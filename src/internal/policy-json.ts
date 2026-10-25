/**
 * The JSON form of a policy tree. The decoder is a plain walk, as the decoder
 * of a condition is, and the two share one budget of `jsonNodes` objects and
 * items. It makes each node with its constructor, so the limits of the nodes
 * hold for a decoded tree too. The binding of the rules to the domain comes
 * after, in the Schema of the policy.
 */
import * as Arr from "effect/Array"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Domain from "../Domain.ts"
import * as Rule from "./rule.ts"
import * as Json from "./json.ts"
import * as Limits from "./limits.ts"
import * as PolicyNodes from "./policy-nodes.ts"

type Node = PolicyNodes.Node

/** Gives the JSON form of a rule. The domain of a rule is not in it. */
const ruleJson = (rule: Rule.Rule, meta: Schema.Top | undefined): unknown => ({
	_tag: rule._tag,
	actions: rule.actions,
	resources: rule.resources,
	...(rule.when === undefined ? {} : { when: Json.toJson(rule.when as never) }),
	...(rule.fields === undefined ? {} : { fields: rule.fields }),
	...(rule.reason === undefined ? {} : { reason: rule.reason }),
	...(rule.id === undefined ? {} : { id: rule.id }),
	// The `meta` of a rule is a decoded value. Its JSON form comes from the
	// `meta` Schema of the domain.
	...(rule.meta === undefined || meta === undefined
		? {}
		: {
				meta: Schema.encodeUnknownSync(meta as Schema.Codec<unknown, unknown>)(
					rule.meta,
				),
			}),
})

/**
 * Gives the JSON form of a policy tree with no predicate. A condition with a
 * predicate has no JSON form, so it throws an error.
 */
export const toJson = (node: Node, meta: Schema.Top | undefined): unknown => {
	switch (node._tag) {
		case "Rules":
			return {
				_tag: "Rules",
				algorithm: node.algorithm,
				rules: Arr.map(node.rules, (rule) => ruleJson(rule, meta)),
			}
		case "All":
		case "Any":
		case "FirstOf":
			return {
				_tag: node._tag,
				policies: Arr.map(node.policies, (child) => toJson(child, meta)),
			}
		case "Ceiling":
			return {
				_tag: "Ceiling",
				cap: toJson(node.cap, meta),
				policy: toJson(node.policy, meta),
			}
	}
}

const algorithms: ReadonlyArray<string> = [
	"denyOverrides",
	"permitOverrides",
	"firstApplicable",
	"lastApplicable",
]

/** Reads a list of strings. */
const readStrings = (
	input: object,
	name: string,
	path: ReadonlyArray<PropertyKey>,
	budget: Json.Budget,
): ReadonlyArray<string> =>
	Arr.map(Json.readList(input, name, path, budget), (value, index) => {
		if (typeof value !== "string") {
			throw Json.problem([...path, name, index], "The item must be a string")
		}
		return value
	})

/** Reads a field that a rule may leave out. */
const readOptional = <A>(
	input: object,
	name: string,
	read: () => A,
): A | undefined => (Object.hasOwn(input, name) ? read() : undefined)

const decodeMeta = (
	value: unknown,
	meta: Schema.Top | undefined,
	path: ReadonlyArray<PropertyKey>,
): unknown => {
	if (meta === undefined) {
		throw Json.problem(path, "The domain has no Schema for meta")
	}
	return Result.getOrThrowWith(
		Schema.decodeUnknownResult(meta as Schema.Codec<unknown, unknown>)(value),
		(error) =>
			new Json.Problem({ path, message: error.message, issue: error.issue }),
	)
}

const decodeRule = (
	input: unknown,
	path: ReadonlyArray<PropertyKey>,
	domain: Domain.Any,
	budget: Json.Budget,
): Rule.Rule => {
	if (typeof input !== "object" || input === null) {
		throw Json.problem(path, "A rule must be an object")
	}
	Json.spend(budget, 1, path)
	const tag = Json.read(input, "_tag", path)
	if (tag !== "Allow" && tag !== "Deny") {
		throw Json.problem([...path, "_tag"], 'A rule must be "Allow" or "Deny"')
	}
	const when = readOptional(input, "when", () =>
		Json.decodeAt(Json.read(input, "when", path), [...path, "when"], budget),
	)
	const fields = readOptional(input, "fields", () =>
		readStrings(input, "fields", path, budget),
	)
	const reason = readOptional(input, "reason", () =>
		Json.readString(input, "reason", path),
	)
	const id = readOptional(input, "id", () => Json.readString(input, "id", path))
	const meta = readOptional(input, "meta", () =>
		decodeMeta(Json.read(input, "meta", path), domain.meta, [...path, "meta"]),
	)
	// Each rule gets the domain of the Schema, as a rule from the builder of
	// the domain has it.
	return Rule.make({
		_tag: tag,
		actions: readStrings(input, "actions", path, budget),
		resources: readStrings(input, "resources", path, budget),
		...(when === undefined ? {} : { when: when as never }),
		...(fields === undefined ? {} : { fields }),
		...(reason === undefined ? {} : { reason }),
		...(id === undefined ? {} : { id }),
		...(meta === undefined ? {} : { meta }),
		domain,
	})
}

const decodeTree = (
	input: unknown,
	path: ReadonlyArray<PropertyKey>,
	depth: number,
	domain: Domain.Any,
	budget: Json.Budget,
): Node => {
	if (depth > Limits.policyDepth) {
		throw Json.problem(
			path,
			`A policy tree has more than ${String(Limits.policyDepth)} levels. The most is ${String(Limits.policyDepth)}.`,
		)
	}
	if (typeof input !== "object" || input === null) {
		throw Json.problem(path, "A node of a policy must be an object")
	}
	Json.spend(budget, 1, path)
	const child = (value: unknown, at: ReadonlyArray<PropertyKey>) =>
		decodeTree(value, at, depth + 1, domain, budget)
	const children = () =>
		Arr.map(Json.readList(input, "policies", path, budget), (value, index) =>
			child(value, [...path, "policies", index]),
		)
	try {
		const tag = Json.read(input, "_tag", path)
		switch (tag) {
			case "Rules": {
				const algorithm = Json.readString(input, "algorithm", path)
				if (!algorithms.includes(algorithm)) {
					throw Json.problem(
						[...path, "algorithm"],
						`"${algorithm}" is not a combining algorithm`,
					)
				}
				return new PolicyNodes.Rules({
					algorithm: algorithm as PolicyNodes.Algorithm,
					rules: Arr.map(
						Json.readList(input, "rules", path, budget),
						(rule, index) =>
							decodeRule(rule, [...path, "rules", index], domain, budget),
					),
				})
			}
			case "All":
				return new PolicyNodes.All(children())
			case "Any":
				return new PolicyNodes.Any(children())
			case "FirstOf":
				return new PolicyNodes.FirstOf(children())
			case "Ceiling":
				return new PolicyNodes.Ceiling({
					cap: child(Json.read(input, "cap", path), [...path, "cap"]),
					policy: child(Json.read(input, "policy", path), [...path, "policy"]),
				})
			default:
				throw Json.problem([...path, "_tag"], "The node has no known tag")
		}
	} catch (error) {
		// A node past a limit is a problem at its place.
		if (error instanceof Limits.LimitExceeded) {
			throw Json.problem(path, error.message)
		}
		throw error
	}
}

/** Decodes the JSON form of a policy tree for a domain. */
export const decode = (
	input: unknown,
	domain: Domain.Any,
): Result.Result<Node, Json.Problem> => {
	try {
		return Result.succeed(decodeTree(input, [], 1, domain, { used: 0 }))
	} catch (error) {
		if (error instanceof Json.Problem) {
			return Result.fail(error)
		}
		throw error
	}
}
