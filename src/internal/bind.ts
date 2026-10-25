/**
 * The binding of rules to a domain. It is the one check of a rule, for a rule
 * from the builder, from `Policy.rule`, and from JSON alike. It reads the
 * catalogs of the resources and of the principal, and it gives one issue for
 * each problem, with the path of the problem and, for a name with a mistake,
 * the name that it may mean.
 */
import * as Arr from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type * as Domain from "../Domain.ts"
import type * as Resource from "../Resource.ts"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as Patterns from "./patterns.ts"
import * as Place from "./place.ts"
import { withSuggestion } from "./suggest.ts"
import * as Trampoline from "./trampoline.ts"

/** One problem of a rule or a policy, with its path. */
export interface Issue {
	readonly path: ReadonlyArray<PropertyKey>
	readonly issue: string
}

/** The data of a rule that the binding reads. */
export interface RuleData {
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: unknown
	readonly fields?: ReadonlyArray<string>
}

/**
 * The memo of one binding, for all its rules. A policy may name one wrong
 * field or one pattern in very many places, so the work on each is done one
 * time. It goes away when the binding ends.
 */
interface Memo {
	/**
	 * The suggestion for each name, by the place where it was looked for. The
	 * names come from a policy, so the map is native, as `fits` is.
	 */
	readonly suggestions: Map<string, string>
	/**
	 * If a pattern matches a field of a kind, by the kind and the pattern. The
	 * patterns come from a policy, so the map is native: the hash of a string
	 * in Effect has no random seed, and a policy could hold very many
	 * patterns with one hash. The engine hashes a string with a random seed.
	 */
	readonly fits: Map<string, boolean>
	/** The count of the issues of conditions so far. It belongs to one binding. */
	readonly issues: { count: number; noted: boolean }
	/** The steps of the checks of patterns so far. It belongs to one binding. */
	readonly work: { steps: number; noted: boolean }
	/** The limits of the domain. */
	readonly limits: Limits.Limits
}

const makeMemo = (limits: Limits.Limits): Memo => ({
	suggestions: new Map(),
	fits: new Map(),
	issues: { count: 0, noted: false },
	work: { steps: 0, noted: false },
	limits,
})

/**
 * The most names that one binding makes a suggestion for. A suggestion
 * compares the name with every name of a catalog, so a policy with very many
 * wrong names would take a long time.
 */
const maxSuggestions = 32

/** Adds a suggestion to a message, with the memo of the binding. */
const suggestIn = (
	memo: Memo,
	message: string,
	name: string,
	scope: string,
	names: () => ReadonlyArray<string>,
): string => {
	const key = `${scope}\u0000${name}`
	const known = memo.suggestions.get(key)
	if (known !== undefined) {
		return known
	}
	if (memo.suggestions.size >= maxSuggestions) {
		return message
	}
	const made = withSuggestion(message, name, names())
	memo.suggestions.set(key, made)
	return made
}

/** The kinds that a rule may run on, from the view of its checks. */
interface Context {
	readonly domain: Domain.Any
	readonly memo: Memo
	/** The rule is for every resource (`"*"`). */
	readonly all: boolean
	/** The resources that the rule names and that the domain has. */
	readonly named: ReadonlyArray<Resource.Descriptor>
	/** The named resources that have one of the actions of the rule. */
	readonly applicable: ReadonlyArray<Resource.Descriptor>
	/**
	 * The resources whose paths a path test may read: every resource with one
	 * of the actions, for a rule for every resource.
	 */
	readonly paths: ReadonlyArray<Resource.Descriptor>
}

type Operand = Nodes.Operand

/**
 * Tests if a field may hold a value of the type of a fixed value. A test with
 * `null` is a test that the field is missing, so `null` always fits. A number
 * fits any field of numbers: a test of an integer field with `1.5` or
 * `Infinity` has a meaning, as `lt` shows.
 */
const fitsLiteral = (kinds: Catalog.Kinds, value: unknown): boolean =>
	value === null ||
	(typeof value === "number" && kinds.number !== "none") ||
	Catalog.accepts(kinds, value)

/**
 * Tests if two fields may hold one scalar. A principal field that is `null`
 * or that holds an object is a missing value, and a test with a missing value
 * is false, so only scalars count.
 */
const meet = (left: Catalog.Kinds, right: Catalog.Kinds): boolean =>
	(left.string && right.string) ||
	(left.boolean && right.boolean) ||
	(left.number !== "none" && right.number !== "none") ||
	Arr.some(left.literals, (value) => Catalog.accepts(right, value)) ||
	Arr.some(right.literals, (value) => Catalog.accepts(left, value))

const hasStrings = (kinds: Catalog.Kinds): boolean =>
	kinds.string || Arr.some(kinds.literals, (value) => typeof value === "string")

const hasNumbers = (kinds: Catalog.Kinds): boolean =>
	kinds.number !== "none" ||
	Arr.some(kinds.literals, (value) => typeof value === "number")

/** Tests if a field may hold a value with an order: a number or a string. */
const isOrdered = (kinds: Catalog.Kinds): boolean =>
	hasStrings(kinds) || hasNumbers(kinds)

/** Tests if two fields may hold values of one ordered type. */
const orderedMeet = (left: Catalog.Kinds, right: Catalog.Kinds): boolean =>
	(hasStrings(left) && hasStrings(right)) ||
	(hasNumbers(left) && hasNumbers(right))

/**
 * The texts of the fields of a catalog that have only names, for
 * suggestions, with the limits of the domain. The domain checked the size of
 * the list when it was made.
 */
const namesOf = (
	catalog: Catalog.Catalog,
	limits: Limits.Limits,
): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(
			Catalog.fieldsOf(catalog, limits.fieldPathParts, limits.catalogFields),
			(field) =>
				Arr.every(field.path, (segment) => typeof segment === "string"),
		),
		(field) => field.text,
	)

/** The issue of a field that is not a field of every resource of the rule. */
const fieldIssue = (
	context: Context,
	field: string,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> => {
	const parts = context.memo.limits.fieldPathParts
	if (field.split(".", parts + 1).length > parts) {
		return [
			{
				path: at,
				issue: `The field path "${field}" has more than ${String(parts)} parts. The most is ${String(parts)}.`,
			},
		]
	}
	const message = `The field "${field}" is not a field of every resource of the rule`
	if (context.all || context.named.length === 0) {
		return [{ path: at, issue: message }]
	}
	const without = Arr.filter(
		context.named,
		(descriptor) =>
			Catalog.lookup(descriptor.catalog, field, parts) === undefined,
	)
	return without.length === 0
		? []
		: [
				{
					path: at,
					issue: suggestIn(context.memo, message, field, without[0]!.kind, () =>
						namesOf(without[0]!.catalog, context.memo.limits),
					),
				},
			]
}

/**
 * The issues of a field that a condition reads: a field that is not a field
 * of every resource of the rule, or a field that is not plain data in one of
 * them. A read of a value that is not plain data, as a getter of a class, is
 * a defect in a decision. A residual may leave the read out, so the residual
 * would say "yes" where the decision fails. So the binding does not take
 * such a read: see `Catalog.Field.plain`.
 */
const readIssues = (
	context: Context,
	field: string,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> => {
	const exists = fieldIssue(context, field, at)
	if (exists.length > 0) {
		return exists
	}
	return Arr.some(
		context.named,
		(descriptor) =>
			!(
				Catalog.lookup(
					descriptor.catalog,
					field,
					context.memo.limits.fieldPathParts,
				)?.plain ?? true
			),
	)
		? [
				{
					path: at,
					issue: `A condition may not read the field "${field}". A value above it may be an object that does not have it as a data field, as a class with a getter, a date or a list. Use a predicate for it.`,
				},
			]
		: []
}

/**
 * The issues of a field pattern: a pattern that does not parse, or that
 * matches no field of the resources of the rule, as a pattern with a mistake
 * in a name does.
 */
const patternIssues = (
	memo: Memo,
	known: ReadonlyArray<Resource.Descriptor>,
	pattern: string,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> =>
	Result.match(Patterns.parse(pattern, memo.limits.patternParts), {
		onFailure: (issue) => [{ path: at, issue }],
		onSuccess: (parsed) => {
			// A rule with no known resource has an issue for that already. The
			// pattern is checked on every kind, not only up to the first that it
			// fits: a decision on a kind does this check, so the limit of the
			// work below is a limit of the work of a decision too.
			const fits =
				known.length === 0 ||
				Arr.reduce(known, false, (before, descriptor) => {
					const key = `${descriptor.kind}\u0000${pattern}`
					return (
						Option.getOrElse(Option.fromUndefinedOr(memo.fits.get(key)), () => {
							// Each check of a pattern reads the steps of a catalog. The
							// work of one binding has a limit, so very many patterns stop
							// with one issue, and the policy does not load.
							memo.work.steps +=
								Math.max(descriptor.catalog.edges, 1) *
								Math.max(parsed.length, 1)
							if (memo.work.steps > memo.limits.searchSteps) {
								return true
							}
							const found = Patterns.fitsCatalog(
								parsed,
								descriptor.catalog,
								memo.limits.fieldPathParts,
							)
							memo.fits.set(key, found)
							return found
						}) || before
					)
				})
			// Past the limit of the work, `ruleIssues` gives one issue for it.
			return fits || memo.work.steps > memo.limits.searchSteps
				? []
				: [
						{
							path: at,
							issue: `The field pattern "${pattern}" matches no field of the resources of the rule`,
						},
					]
		},
	})

/** The fields of the resources that a test of the rule may read. */
const fieldsAt = (
	context: Context,
	field: string,
): ReadonlyArray<Catalog.Field> =>
	Arr.flatMap(context.applicable, (descriptor) => {
		const found = Catalog.lookup(
			descriptor.catalog,
			field,
			context.memo.limits.fieldPathParts,
		)
		return found === undefined ? [] : [found]
	})

/** The field of the principal that an operand names, or the issue when there is none. */
const principalField = (
	context: Context,
	ref: string,
	at: ReadonlyArray<PropertyKey>,
): Catalog.Field | Issue => {
	const found = Catalog.lookup(
		context.domain.principalCatalog,
		ref,
		context.memo.limits.fieldPathParts,
	)
	// A read of the principal that is not plain data is a defect, as a read
	// of a resource is: see `readIssues`.
	if (found !== undefined && !found.plain) {
		return {
			path: at,
			issue: `A condition may not read the field "${ref}" of the principal. A value above it may be an object that does not have it as a data field, as a class with a getter, a date or a list. Use a predicate for it.`,
		}
	}
	return found !== undefined
		? found
		: {
				path: at,
				issue: suggestIn(
					context.memo,
					`The principal has no field "${ref}"`,
					ref,
					"~principal",
					() => namesOf(context.domain.principalCatalog, context.memo.limits),
				),
			}
}

const isIssue = (value: Catalog.Field | Issue): value is Issue =>
	"issue" in value

/**
 * The fields that a test reads, with one field for each distinct kind of
 * value. A rule for very many kinds may have one field type in all of them,
 * so each value of the test is checked one time for each distinct kind, not
 * one time for each resource. The kinds are found by their text in a native
 * `Map`, which belongs to this call.
 */
const distinctFields = (
	context: Context,
	field: string,
): ReadonlyArray<Catalog.Field> =>
	Array.from(
		new Map(
			Arr.map(
				fieldsAt(context, field),
				(found) => [JSON.stringify(found.kinds), found] as const,
			),
		).values(),
	)

/**
 * Counts the work of the checks of the values of a test, as the work of the
 * field patterns counts. Past the limit, the values are not checked, and
 * `ruleIssues` gives one issue for the work.
 */
const spendChecks = (memo: Memo, values: number, fields: number): boolean => {
	memo.work.steps += values * Math.max(fields, 1)
	return memo.work.steps <= memo.limits.searchSteps
}

/** The issues of one operand of a test of a field, with its distinct fields. */
const operandIssues = (
	context: Context,
	field: string,
	fields: ReadonlyArray<Catalog.Field>,
	ordered: boolean,
	operand: Operand,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> => {
	if (operand._tag === "Literal") {
		const value = operand.value
		if (ordered && typeof value !== "string" && typeof value !== "number") {
			return [
				{
					path: at,
					issue: `The field "${field}" has an ordered test with a value that has no order`,
				},
			]
		}
		return [
			...(Arr.some(fields, (found) => !fitsLiteral(found.kinds, value))
				? [
						{
							path: at,
							issue: `The field "${field}" can not hold the value ${JSON.stringify(value)}`,
						},
					]
				: []),
			...(ordered && Arr.some(fields, (found) => !isOrdered(found.kinds))
				? [
						{
							path: at,
							issue: `The field "${field}" has an ordered test with a value that has no order`,
						},
					]
				: []),
		]
	}
	const principal = principalField(context, operand.path, at)
	if (isIssue(principal)) {
		return [principal]
	}
	return [
		...(Arr.some(fields, (found) => !meet(found.kinds, principal.kinds))
			? [
					{
						path: at,
						issue: `The field "${field}" can not hold a value of the principal field "${operand.path}"`,
					},
				]
			: []),
		...(ordered &&
		Arr.some(fields, (found) => !orderedMeet(found.kinds, principal.kinds))
			? [
					{
						path: at,
						issue: `The field "${field}" has an ordered test with a value that has no order`,
					},
				]
			: []),
	]
}

/**
 * Tests if the path of a resource may start with a prefix: it is as long as
 * the prefix, and each fixed string of the prefix is the string of the path
 * at its place, when the path has a string there.
 */
const mayStartWith = (
	descriptor: Resource.Descriptor,
	strings: ReadonlyArray<string | null>,
): boolean =>
	(descriptor.path?.length ?? 0) >= strings.length &&
	Arr.every(strings, (string, index) => {
		const segment = descriptor.path?.[index]
		return string === null || typeof segment !== "string" || segment === string
	})

/** The kinds of the part of the path of a resource at a place. */
const pathPartKinds = (
	descriptor: Resource.Descriptor,
	index: number,
): Catalog.Kinds | string | undefined => {
	const segment = descriptor.path?.[index]
	return segment === undefined || typeof segment === "string"
		? segment
		: (Catalog.lookup(descriptor.catalog, segment.field)?.kinds ??
				Catalog.anyKinds)
}

/** The issues of the prefix of a path test. */
const underIssues = (
	context: Context,
	prefix: ReadonlyArray<Operand>,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> => {
	const strings = Arr.map(prefix, (operand) =>
		operand._tag === "Literal" && typeof operand.value === "string"
			? operand.value
			: null,
	)
	// The test can match only a path that starts with the fixed strings of
	// the prefix, so the other resources are left out.
	const candidates = Arr.filter(context.paths, (descriptor) =>
		mayStartWith(descriptor, strings),
	)
	return Arr.flatMap(prefix, (operand, index): ReadonlyArray<Issue> => {
		const place = [...at, "prefix", index]
		if (operand._tag === "Literal") {
			return Arr.some(candidates, (descriptor) => {
				const kinds = pathPartKinds(descriptor, index)
				return typeof kinds === "object" && !fitsLiteral(kinds, operand.value)
			})
				? [
						{
							path: place,
							issue: `The path part ${String(index)} can not hold the value ${JSON.stringify(operand.value)}`,
						},
					]
				: []
		}
		const principal = principalField(context, operand.path, place)
		if (isIssue(principal)) {
			return [principal]
		}
		return Arr.some(candidates, (descriptor) => {
			const kinds = pathPartKinds(descriptor, index)
			return kinds === undefined
				? true
				: typeof kinds === "string"
					? !Catalog.accepts(principal.kinds, kinds)
					: !meet(kinds, principal.kinds)
		})
			? [
					{
						path: place,
						issue: `The principal field "${operand.path}" can not hold a part of the path of the resource`,
					},
				]
			: []
	})
}

const notWhole = (at: ReadonlyArray<PropertyKey>): Issue => ({
	path: at,
	issue: "The condition is not a whole condition tree",
})

/**
 * The most issues that the walk of the conditions of one binding gives. A
 * policy may have very many wrong tests, and each issue keeps its path.
 */
const maxIssues = 100

/**
 * The place of a part of a policy, which a walk turns into a full path only
 * for an issue: see `Place`.
 */
type At = Place.Place | undefined

/**
 * Puts the path of a node before the paths of its issues. A walk keeps no
 * path for a node with no issue, so a deep and wide condition costs little.
 */
const under = (
	memo: Memo,
	at: At,
	issues: ReadonlyArray<Issue>,
): ReadonlyArray<Issue> => {
	if (issues.length === 0) {
		return issues
	}
	const room = maxIssues - memo.issues.count
	memo.issues.count += issues.length
	const kept = Arr.map(Arr.take(issues, Math.max(room, 0)), (issue) => ({
		path: [...Place.pathOf(at), ...issue.path],
		issue: issue.issue,
	}))
	const first = memo.issues.count > maxIssues && !memo.issues.noted
	memo.issues.noted ||= first
	return first
		? [
				...kept,
				{
					path: [],
					issue: `The policy has more problems. The first ${String(maxIssues)} are here.`,
				},
			]
		: kept
}

/**
 * The issues of a condition. The constructors of the nodes checked the shape
 * of each node, so this checks the names and the types against the domain. A
 * node that the condition uses in many places is checked one time. The nodes
 * it has seen are in a native `Set`, because it must find a node by the node
 * itself: `Equal` compares nodes by structure.
 */
const conditionIssues = (
	context: Context,
	root: Nodes.Node,
	rootAt: At,
	seen: Set<Nodes.Node>,
): ReadonlyArray<Issue> =>
	// The walk takes the steps of a trampoline, so a deep condition does not
	// fill the stack.
	Trampoline.run(root.depth, (R) => {
		// A test looks its field up in each resource of the rule. A rule for
		// very many kinds with very many tests is very much work, so it counts.
		// Past the limit, `ruleIssues` gives one issue for it, and the policy
		// does not load.
		const room = (values: number) =>
			spendChecks(context.memo, 1 + values, context.named.length)
		const leaf = (node: Nodes.Node, at: At): ReadonlyArray<Issue> => {
			const here = (issues: ReadonlyArray<Issue>) =>
				under(context.memo, at, issues)
			switch (node._tag) {
				case "Compare": {
					if (!room(1)) {
						return []
					}
					const exists = readIssues(context, node.field, ["field"])
					return here(
						exists.length > 0
							? exists
							: operandIssues(
									context,
									node.field,
									distinctFields(context, node.field),
									node.op !== "eq" && node.op !== "ne",
									node.value,
									["value"],
								),
					)
				}
				case "In": {
					if (!room(0)) {
						return []
					}
					const exists = readIssues(context, node.field, ["field"])
					if (exists.length > 0) {
						return here(exists)
					}
					const fields = distinctFields(context, node.field)
					if (!spendChecks(context.memo, node.values.length, fields.length)) {
						return []
					}
					return here(
						Arr.flatMap(node.values, (operand, index) =>
							operandIssues(context, node.field, fields, false, operand, [
								"values",
								index,
							]),
						),
					)
				}
				case "Exists":
					return room(0) ? here(readIssues(context, node.field, ["field"])) : []
				case "Under":
					// The check reads the path of each resource of the rule for each
					// part of the prefix, so it counts that work first.
					return spendChecks(
						context.memo,
						1 + node.prefix.length,
						context.paths.length,
					)
						? here(underIssues(context, node.prefix, []))
						: []
				default:
					return []
			}
		}
		const go = (
			node: Nodes.Node,
			at: At,
		): Trampoline.Step<ReadonlyArray<Issue>> => {
			if (seen.has(node)) {
				return R.succeed([])
			}
			seen.add(node)
			switch (node._tag) {
				case "And":
				case "Or":
					return R.map(
						R.forEach(node.conditions, (child, index) =>
							R.suspend(() => go(child, Place.at(at, "conditions", index))),
						),
						Arr.flatten,
					)
				case "Not":
					return R.suspend(() => go(node.condition, Place.at(at, "condition")))
				default:
					return R.succeed(leaf(node, at))
			}
		}
		return go(root, rootAt)
	})

const hasAction = (
	descriptor: Resource.Descriptor,
	actions: ReadonlyArray<string>,
): boolean =>
	actions.includes("*") ||
	Arr.some(actions, (action) => descriptor.actions.includes(action))

/**
 * Checks one rule against a domain. It gives one issue for each problem, up
 * to the most issues of the binding. `at` is the place of the rule, and its
 * full path is made only for an issue that the binding keeps: a rule with
 * very many problems deep in a tree does not make a full path for each one.
 */
export const ruleIssues = (
	domain: Domain.Any,
	rule: RuleData,
	at: At,
	memo: Memo = makeMemo(domain.limits),
): ReadonlyArray<Issue> => {
	const here = (issues: ReadonlyArray<Issue>) => under(memo, at, issues)
	const all = rule.resources.includes("*")
	// Each kind is checked one time, also when the list names it again. The
	// names come from a policy, so a native `Set` finds the copies:
	// `Arr.dedupe` puts the names in groups by the hash of Effect, which has
	// no random seed, and very many names with one hash make one long group.
	const names = Array.from(
		new Set(Arr.filter(rule.resources, (kind) => kind !== "*")),
	)
	const kinds = Array.from(HashMap.keys(domain.resources))
	const named = Arr.flatMap(names, (kind) =>
		Option.toArray(HashMap.get(domain.resources, kind)),
	)
	const known = all ? Array.from(HashMap.values(domain.resources)) : named
	// The rule never runs on a kind without one of its actions, so the types
	// of its tests are checked only on the kinds with one.
	const applicable = Arr.filter(named, (descriptor) =>
		hasAction(descriptor, rule.actions),
	)
	const context: Context = {
		domain,
		memo,
		all,
		named,
		applicable,
		paths: all
			? Arr.filter(known, (descriptor) => hasAction(descriptor, rule.actions))
			: applicable,
	}
	// A native `Set` finds copies about ten times as fast as `Arr.dedupe`.
	const actions = Array.from(
		new Set(Arr.flatMap(known, (descriptor) => descriptor.actions)),
	)
	const fieldIssues = Arr.flatMap(rule.fields ?? [], (field, index) =>
		here(
			field.includes("*")
				? patternIssues(memo, known, field, ["fields", index])
				: fieldIssue(context, field, ["fields", index]),
		),
	)
	const conditionNodes = memo.limits.conditionNodes
	const whenIssues =
		rule.when === undefined
			? []
			: !Nodes.isNode(rule.when)
				? here([notWhole(["when"])])
				: // The constructors of the nodes check the ceiling, so the binding
					// checks the limit of the domain.
					rule.when.weight > conditionNodes
					? here([
							{
								path: ["when"],
								issue: `A condition has ${String(rule.when.weight)} nodes and values. The most is ${String(conditionNodes)}.`,
							},
						])
					: conditionIssues(context, rule.when, Place.at(at, "when"), new Set())
	// The work is known only after every check of the rule. Past the limit, a
	// check gives no issue, so this issue must come, or the policy would load
	// with checks left out.
	const work = memo.work.steps > memo.limits.searchSteps && !memo.work.noted
	memo.work.noted ||= work
	return [
		...Arr.flatMap(
			Arr.filter(names, (kind) => !HashMap.has(domain.resources, kind)),
			(kind: string) =>
				here([
					{
						path: ["resources"],
						issue: suggestIn(
							memo,
							`There is no resource with the kind "${kind}"`,
							kind,
							"~kinds",
							() => kinds,
						),
					},
				]),
		),
		...Arr.flatMap(
			Arr.filter(
				rule.actions,
				(action) => action !== "*" && !actions.includes(action),
			),
			(action: string) =>
				here([
					{
						path: ["actions"],
						issue: suggestIn(
							memo,
							`The action "${action}" is not an action of these resources`,
							action,
							`~actions\u0000${names.join(",")}`,
							() => actions,
						),
					},
				]),
		),
		...fieldIssues,
		...whenIssues,
		// The issue of the work is not one of the most issues of the binding,
		// so a policy past the limit always says why.
		...(work
			? [
					{
						path: Place.pathOf(at),
						issue: `The policy takes more than ${String(memo.limits.searchSteps)} steps to check: its field patterns, and the fields and values of its tests on each resource. The most is ${String(memo.limits.searchSteps)}.`,
					},
				]
			: []),
	]
}

/** The JSON form of a policy tree, or a policy tree, as the binding reads it. */
type TreeNode =
	| { readonly _tag: "Rules"; readonly rules: ReadonlyArray<RuleData> }
	| {
			readonly _tag: "All" | "Any" | "FirstOf"
			readonly policies: ReadonlyArray<TreeNode>
	  }
	| {
			readonly _tag: "Ceiling"
			readonly cap: TreeNode
			readonly policy: TreeNode
	  }

/** Checks each rule of a policy tree against a domain. */
export const treeIssues = (
	domain: Domain.Any,
	root: TreeNode,
): ReadonlyArray<Issue> => {
	// The rules come out of the tree first, and each one is checked after.
	// A check of a condition goes down its levels, so a check inside the walk
	// of the tree would go down the levels of both. The place of each rule
	// shares the path of its parent. The tree may be the JSON form, with no
	// depth that a node knows, so the walk is a walk of the trampoline for an
	// input of an unknown depth.
	// The rules go into one list, in order: a walk that joined the lists of
	// the children at each node would copy the list of a deep tree at each
	// level. The list belongs to this walk.
	const found: Array<readonly [RuleData, Place.Place]> = []
	const rulesOf = Trampoline.adaptive<
		{ readonly node: TreeNode; readonly at: At },
		undefined
	>((R, child) => ({ node, at }, level) => {
		const below = (
			parts: ReadonlyArray<{ readonly node: TreeNode; readonly at: At }>,
		) =>
			R.map(
				R.forEach(parts, (part) => child(part, level + 1)),
				() => undefined,
			)
		switch (node._tag) {
			case "Rules":
				Arr.forEach(node.rules, (rule, index) => {
					found.push([rule, Place.at(at, "rules", index)])
				})
				return R.succeed(undefined)
			case "All":
			case "Any":
			case "FirstOf":
				return below(
					Arr.map(node.policies, (inner, index) => ({
						node: inner,
						at: Place.at(at, "policies", index),
					})),
				)
			case "Ceiling":
				return below([
					{ node: node.cap, at: Place.at(at, "cap") },
					{ node: node.policy, at: Place.at(at, "policy") },
				])
		}
	})
	rulesOf({ node: root, at: undefined })
	const memo = makeMemo(domain.limits)
	return Arr.flatMap(found, ([rule, place]) =>
		ruleIssues(domain, rule, place, memo),
	)
}
