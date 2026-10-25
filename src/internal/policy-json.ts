/**
 * The JSON form of a policy tree. The decoder is a plain walk, as the decoder
 * of a condition is, and the two share one budget of `jsonNodes` objects and
 * items. It makes each node with its constructor, so the limits of the nodes
 * hold for a decoded tree too. The binding of the rules to the domain comes
 * after, in the Schema of the policy.
 */
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Domain from "../Domain.ts"
import * as Rule from "./rule.ts"
import * as Json from "./json.ts"
import * as Limits from "./limits.ts"
import * as PolicyNodes from "./policy-nodes.ts"

type Node = PolicyNodes.Node

/**
 * The codec of the `meta` Schema of a domain to and from JSON. The JSON form
 * of a policy must stay the same through `JSON.stringify` and `JSON.parse`, so
 * a `Date` in `meta`, for one, becomes a string in it, and a string again
 * when it is decoded.
 */
const metaCodec = (meta: Schema.Top): Schema.Codec<unknown, unknown> =>
	Schema.toCodecJson(meta) as unknown as Schema.Codec<unknown, unknown>

/** Gives the JSON form of the `meta` of a rule, or `undefined` for none. */
export type MetaJson = (rule: Rule.Rule) => unknown

/**
 * Gives the JSON form of the `meta` of each rule at once, with the `meta`
 * Schema of a domain. `JSON.stringify` needs it at once, so the Schema must
 * not need an async step there.
 */
export const syncMeta =
	(meta: Schema.Top | undefined): MetaJson =>
	(rule) =>
		rule.meta === undefined || meta === undefined
			? undefined
			: Schema.encodeUnknownSync(metaCodec(meta))(rule.meta)

/** The JSON form of the condition of each rule, by the rule. */
type WhenJson = (rule: Rule.Rule) => unknown

/** Gives the JSON form of a rule. The domain of a rule is not in it. */
const ruleJson = (
	rule: Rule.Rule,
	metaJson: MetaJson,
	whenJson: WhenJson,
): unknown => {
	const meta = metaJson(rule)
	return {
		_tag: rule._tag,
		actions: rule.actions,
		resources: rule.resources,
		...(rule.when === undefined ? {} : { when: whenJson(rule) }),
		...(rule.fields === undefined ? {} : { fields: rule.fields }),
		...(rule.reason === undefined ? {} : { reason: rule.reason }),
		...(rule.id === undefined ? {} : { id: rule.id }),
		// The `meta` of a rule is a decoded value. Its JSON form comes from the
		// `meta` Schema of the domain.
		...(meta === undefined ? {} : { meta }),
	}
}

/**
 * Gives the JSON form of a policy tree with no predicate. A condition with a
 * predicate has no JSON form, so it throws an error. The conditions are
 * written first, from a flat list of the rules, so the walk does not go down
 * the levels of the tree and of a condition at once.
 */
export const toJson = (node: Node, meta: MetaJson): unknown => {
	// A native map, because it must find a rule by the rule itself: two rules
	// with the same data are `Equal`.
	const whens = new Map<Rule.Rule, unknown>(
		Arr.map(PolicyNodes.rulesOf(node), (rule) => [
			rule,
			rule.when === undefined ? undefined : Json.toJson(rule.when as never),
		]),
	)
	const tree = (current: Node): unknown => {
		switch (current._tag) {
			case "Rules":
				return {
					_tag: "Rules",
					algorithm: current.algorithm,
					rules: Arr.map(current.rules, (rule) =>
						ruleJson(rule, meta, (found) => whens.get(found)),
					),
				}
			case "All":
			case "Any":
			case "FirstOf":
				return {
					_tag: current._tag,
					policies: Arr.map(current.policies, tree),
				}
			case "Ceiling":
				return {
					_tag: "Ceiling",
					cap: tree(current.cap),
					policy: tree(current.policy),
				}
		}
	}
	return tree(node)
}

/**
 * Gives the JSON form of a policy tree as an Effect. The `meta` Schema of the
 * domain may need an async step, so each `meta` is encoded as an Effect.
 */
export const encode = (
	node: Node,
	meta: Schema.Top | undefined,
): Effect.Effect<unknown, Schema.SchemaError> =>
	Effect.gen(function* () {
		const rules = Arr.filter(
			PolicyNodes.rulesOf(node),
			(rule) => rule.meta !== undefined,
		)
		const encoded =
			meta === undefined
				? []
				: yield* Effect.forEach(rules, (rule) =>
						Effect.map(
							Schema.encodeUnknownEffect(metaCodec(meta))(rule.meta),
							(json) => [rule, json] as const,
						),
					)
		// A native map, because it must find a rule by the rule itself: two
		// rules with the same data are `Equal`, and each keeps its own form.
		const forms = new Map<Rule.Rule, unknown>(encoded)
		return toJson(node, (rule) => forms.get(rule))
	})

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

/**
 * Reads a field that a rule may leave out. A field that the input has only
 * from the prototype of a class is not plain data, so it is a problem: a rule
 * that loses its condition would allow more.
 */
const readOptional = <A>(
	input: object,
	name: string,
	path: ReadonlyArray<PropertyKey>,
	read: () => A,
): A | undefined => {
	if (Object.hasOwn(input, name)) {
		return read()
	}
	// A read of the field throws a problem when the field is not data.
	Json.read(input, name, path)
	return undefined
}

/** Counts the objects and items of a value, as the other parts count. */
const spendValue = (
	value: unknown,
	path: ReadonlyArray<PropertyKey>,
	depth: number,
	budget: Json.Budget,
): void => {
	if (typeof value !== "object" || value === null) {
		return
	}
	if (depth > Limits.conditionDepth) {
		throw Json.problem(
			path,
			`The value has more than ${String(Limits.conditionDepth)} levels. The most is ${String(Limits.conditionDepth)}.`,
		)
	}
	// The length of an array counts before its items are read, so a sparse
	// array with a very large length stops at once.
	const list = Array.isArray(value)
	if (list) {
		Json.spend(budget, 1 + value.length, path)
	}
	const names = list
		? Array.from({ length: value.length }, (_, index) => String(index))
		: Object.keys(value)
	if (!list) {
		Json.spend(budget, 1 + names.length, path)
	}
	Arr.forEach(names, (name) =>
		spendValue(
			Json.read(value, name, path),
			[...path, name],
			depth + 1,
			budget,
		),
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

/**
 * Decodes the `meta` of a rule with the `meta` Schema of the domain, as an
 * Effect, since the Schema may need an async step. The Schema reads all of
 * the value, so its size counts in the budget.
 */
const decodeMeta = (
	{ input, path }: RuleInput,
	domain: Domain.Any,
	budget: Json.Budget,
): Effect.Effect<unknown, Json.Problem> =>
	Effect.flatMap(
		attempt(() =>
			typeof input !== "object" || input === null
				? undefined
				: readOptional(input, "meta", path, () => {
						const value = Json.read(input, "meta", path)
						if (domain.meta === undefined) {
							throw Json.problem(
								[...path, "meta"],
								"The domain has no Schema for meta",
							)
						}
						spendValue(value, [...path, "meta"], 1, budget)
						return { value, schema: domain.meta }
					}),
		),
		(found) =>
			found === undefined
				? Effect.void
				: Effect.mapError(
						Schema.decodeUnknownEffect(metaCodec(found.schema))(found.value),
						(error) =>
							new Json.Problem({
								path: [...path, "meta"],
								message: error.message,
								issue: error.issue,
							}),
					),
	)

const decodeRule = (
	{ input, path }: RuleInput,
	meta: unknown,
	budget: Json.Budget,
	domain: Domain.Any,
): Rule.Rule => {
	if (typeof input !== "object" || input === null) {
		throw Json.problem(path, "A rule must be an object")
	}
	Json.spend(budget, 1, path)
	const tag = Json.read(input, "_tag", path)
	if (tag !== "Allow" && tag !== "Deny") {
		throw Json.problem([...path, "_tag"], 'A rule must be "Allow" or "Deny"')
	}
	const when = readOptional(input, "when", path, () =>
		Json.decodeAt(Json.read(input, "when", path), [...path, "when"], budget),
	)
	const fields = readOptional(input, "fields", path, () =>
		readStrings(input, "fields", path, budget),
	)
	const reason = readOptional(input, "reason", path, () =>
		Json.readString(input, "reason", path),
	)
	const id = readOptional(input, "id", path, () =>
		Json.readString(input, "id", path),
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

/** Runs a step that may throw a problem, and puts the problem in the error. */
const attempt = <A>(step: () => A): Effect.Effect<A, Json.Problem> =>
	Effect.try({
		try: step,
		catch: (error) => {
			if (error instanceof Json.Problem) {
				return error
			}
			throw error
		},
	})

/**
 * Decodes the JSON form of a policy tree for a domain. It reads the tree
 * first, then the `meta` of each rule as an Effect, then the rules, and it
 * makes the nodes last.
 */
export const decode = (
	input: unknown,
	domain: Domain.Any,
): Effect.Effect<Node, Json.Problem> =>
	Effect.gen(function* () {
		const budget: Json.Budget = { used: 0 }
		// The rules of this decode. The list belongs to this decode.
		const inputs: Array<RuleInput> = []
		const plan = yield* attempt(() => readTree(input, [], 1, budget, inputs))
		const metas = yield* Effect.forEach(inputs, (rule) =>
			decodeMeta(rule, domain, budget),
		)
		const rules = yield* attempt(() =>
			Arr.map(inputs, (rule, index) =>
				decodeRule(rule, metas[index], budget, domain),
			),
		)
		return yield* attempt(() => build(plan, rules))
	})
