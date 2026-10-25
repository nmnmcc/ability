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

/** A rule in the input, with its place, to decode after the tree. */
interface RuleInput {
	readonly input: unknown
	readonly path: ReadonlyArray<PropertyKey>
}

/**
 * The shape of a tree, with the place of each rule in a flat list. `size`
 * counts the nodes and the rules, as the nodes do, so a shared input stops
 * at `policyNodes` before the decoder reads all of it.
 */
type Plan =
	| {
			readonly _tag: "Rules"
			readonly path: ReadonlyArray<PropertyKey>
			readonly size: number
			readonly algorithm: PolicyNodes.Algorithm
			readonly rules: ReadonlyArray<number>
	  }
	| {
			readonly _tag: "All" | "Any" | "FirstOf"
			readonly path: ReadonlyArray<PropertyKey>
			readonly size: number
			readonly policies: ReadonlyArray<Plan>
	  }
	| {
			readonly _tag: "Ceiling"
			readonly path: ReadonlyArray<PropertyKey>
			readonly size: number
			readonly cap: Plan
			readonly policy: Plan
	  }

const decodeRule = (
	{ input, path }: RuleInput,
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

/**
 * Reads the shape of a tree, and puts each rule in `rules`. The rules are
 * decoded after the walk: a condition has levels of its own, and a decode
 * inside the walk would go down the levels of both.
 */
const readTree = (
	input: unknown,
	path: ReadonlyArray<PropertyKey>,
	depth: number,
	budget: Json.Budget,
	// The rules of one decode. The list belongs to that decode.
	rules: Array<RuleInput>,
): Plan => {
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
		readTree(value, at, depth + 1, budget, rules)
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
			const found = Arr.map(
				Json.readList(input, "rules", path, budget),
				(rule, index) =>
					rules.push({ input: rule, path: [...path, "rules", index] }) - 1,
			)
			return sized({
				_tag: "Rules",
				path,
				size: 1 + found.length,
				algorithm: algorithm as PolicyNodes.Algorithm,
				rules: found,
			})
		}
		case "All":
		case "Any":
		case "FirstOf": {
			const policies = Arr.map(
				Json.readList(input, "policies", path, budget),
				(value, index) => child(value, [...path, "policies", index]),
			)
			return sized({
				_tag: tag,
				path,
				size: Arr.reduce(policies, 1, (total, plan) => total + plan.size),
				policies,
			})
		}
		case "Ceiling": {
			const cap = child(Json.read(input, "cap", path), [...path, "cap"])
			const policy = child(Json.read(input, "policy", path), [
				...path,
				"policy",
			])
			return sized({
				_tag: "Ceiling",
				path,
				size: 1 + cap.size + policy.size,
				cap,
				policy,
			})
		}
		default:
			throw Json.problem([...path, "_tag"], "The node has no known tag")
	}
}

/** Stops a plan past `policyNodes`, with the message of the nodes. */
const sized = (plan: Plan): Plan => {
	if (plan.size > Limits.policyNodes) {
		throw Json.problem(
			plan.path,
			`A policy tree has ${String(plan.size)} nodes. The most is ${String(Limits.policyNodes)}.`,
		)
	}
	return plan
}

/** Makes the nodes of a plan, with the decoded rules. */
const build = (plan: Plan, rules: ReadonlyArray<Rule.Rule>): Node => {
	try {
		switch (plan._tag) {
			case "Rules":
				return new PolicyNodes.Rules({
					algorithm: plan.algorithm,
					rules: Arr.map(plan.rules, (index) => rules[index]!),
				})
			case "All":
			case "Any":
			case "FirstOf":
				return new PolicyNodes[plan._tag](
					Arr.map(plan.policies, (child) => build(child, rules)),
				)
			case "Ceiling":
				return new PolicyNodes.Ceiling({
					cap: build(plan.cap, rules),
					policy: build(plan.policy, rules),
				})
		}
	} catch (error) {
		// A node past a limit is a problem at its place.
		if (error instanceof Limits.LimitExceeded) {
			throw Json.problem(plan.path, error.message)
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
		const budget: Json.Budget = { used: 0 }
		const inputs: Array<RuleInput> = []
		const plan = readTree(input, [], 1, budget, inputs)
		const rules = Arr.map(inputs, (rule) => decodeRule(rule, domain, budget))
		return Result.succeed(build(plan, rules))
	} catch (error) {
		if (error instanceof Json.Problem) {
			return Result.fail(error)
		}
		throw error
	}
}
