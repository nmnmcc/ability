/**
 * The one table of limits. Each limit keeps a walk, a decoder or a search
 * bounded, so no input can take a very long time or very much memory. A
 * domain may set its own limits, up to the ceilings.
 */
import * as Schema from "effect/Schema"

/** The values of all the limits. */
export interface Limits {
	/** The most parts of a field path, as in `settings.model`. */
	readonly fieldPathParts: number
	/** The most parts of a field pattern, as in `**.secret`. */
	readonly patternParts: number
	/**
	 * The most nodes of one condition. A child that a condition uses in many
	 * places is counted for each place.
	 */
	readonly conditionNodes: number
	/** The most nodes of one residual condition. */
	readonly residualNodes: number
	/**
	 * The most nodes of a policy tree, with its rules and the nodes of their
	 * conditions. A part that the tree uses in many places is counted for
	 * each place.
	 */
	readonly policyNodes: number
	/** The most objects and arrays in one input to a decoder. */
	readonly jsonNodes: number
	/** The most fields in the list of the fields of one Schema. */
	readonly catalogFields: number
	/** The most steps of one search for a value. */
	readonly searchSteps: number
	/** The most fields that one search for a value may test. */
	readonly searchFields: number
	/**
	 * The most objects and items of a principal that the Authorizer makes the
	 * JSON form of, for its cache key. A part that the principal uses in many
	 * places is counted for each place, as its JSON form has it there.
	 */
	readonly principalNodes: number
}

/**
 * The limits of a domain that sets none. A walk does not fill the stack at
 * any depth (see `Trampoline`), and the levels of a condition or of a policy
 * tree are at most its nodes, so the limits of the nodes keep the time and
 * the memory of a deep input small too. There is no limit of levels.
 */
export const defaults: Limits = {
	fieldPathParts: 1000,
	patternParts: 1000,
	conditionNodes: 1_000_000,
	residualNodes: 100_000,
	policyNodes: 1_000_000,
	jsonNodes: 10_000_000,
	catalogFields: 100_000,
	// A search is the work of one check of a kind, as in the Authorizer, so
	// its steps are a limit of the time of one request.
	searchSteps: 1_000_000,
	searchFields: 1000,
	principalNodes: 100_000,
}

/**
 * The most that a domain may set for each limit. The constructors of the
 * nodes check these, since a node does not know its domain. The binding to a
 * domain checks the limits of the domain.
 */
export const ceilings: Limits = {
	fieldPathParts: 10_000,
	patternParts: 10_000,
	conditionNodes: 100_000_000,
	residualNodes: 100_000_000,
	policyNodes: 100_000_000,
	jsonNodes: 1_000_000_000,
	catalogFields: 10_000_000,
	searchSteps: 1_000_000_000,
	searchFields: 100_000,
	principalNodes: 100_000_000,
}

/** The Schema of one limit: a whole number from 1 up to its ceiling. */
const limit = (name: keyof Limits) =>
	Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ceilings[name] })),
	)

/**
 * The Schema of the limits that a domain sets. Each one is a whole number
 * from 1 up to its ceiling, and a limit that the domain leaves out has its
 * default.
 */
export const Options = Schema.Struct({
	fieldPathParts: limit("fieldPathParts"),
	patternParts: limit("patternParts"),
	conditionNodes: limit("conditionNodes"),
	residualNodes: limit("residualNodes"),
	policyNodes: limit("policyNodes"),
	jsonNodes: limit("jsonNodes"),
	catalogFields: limit("catalogFields"),
	searchSteps: limit("searchSteps"),
	searchFields: limit("searchFields"),
	principalNodes: limit("principalNodes"),
})

/**
 * Makes the limits of a domain from the ones that it sets. A value that is
 * not a whole number from 1 up to its ceiling is a mistake in the code, so
 * it is a defect.
 */
export const make = (options: unknown = {}): Limits => ({
	...defaults,
	...Schema.decodeUnknownSync(Options)(options),
})

// The default of each limit, by its name.

export const fieldPathParts = defaults.fieldPathParts
export const patternParts = defaults.patternParts
export const conditionNodes = defaults.conditionNodes
export const residualNodes = defaults.residualNodes
export const policyNodes = defaults.policyNodes
export const jsonNodes = defaults.jsonNodes
export const catalogFields = defaults.catalogFields
export const searchSteps = defaults.searchSteps
export const searchFields = defaults.searchFields
export const principalNodes = defaults.principalNodes

/**
 * The error when an input goes past a limit. It names the limit, the size of
 * the input, and the most that the limit takes.
 */
export class LimitExceeded extends Schema.TaggedError<LimitExceeded>(
	"@nmnmcc/ability/Limits/LimitExceeded",
)("LimitExceeded", {
	limit: Schema.String,
	size: Schema.Finite,
	max: Schema.Finite,
	message: Schema.String,
}) {}

/**
 * Makes the error for a limit, with one form of message for every limit, as
 * in "A condition has 100001 nodes. The most is 100000."
 */
export const exceeded = (
	thing: string,
	limit: string,
	unit: string,
	size: number,
	max: number,
): LimitExceeded =>
	LimitExceeded.make({
		limit,
		size,
		max,
		message: `${thing} has ${String(size)} ${unit}. The most is ${String(max)}.`,
	})
