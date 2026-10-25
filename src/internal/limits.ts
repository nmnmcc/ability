/**
 * The one table of limits. Each limit keeps a walk, a decoder or a search
 * bounded, so no input can fill the stack or take a very long time. The
 * values are the same in the types and at run time where both have one, as
 * for the parts of a field path.
 */
import * as Schema from "effect/Schema"

/** The most parts of a field path, as in `settings.model`. */
export const fieldPathParts = 5

/** The most parts of a field pattern, as in `**.secret`. */
export const patternParts = 16

/**
 * The most nodes of one condition. A child that a condition uses in many
 * places is counted for each place.
 */
export const conditionNodes = 100_000

/** The most levels of one condition. */
export const conditionDepth = 500

/** The most nodes of one residual condition. */
export const residualNodes = 10_000

/** The most levels of a policy tree. */
export const policyDepth = 256

/**
 * The most nodes of a policy tree, with its rules and the nodes of their
 * conditions. A part that the tree uses in many places is counted for each
 * place.
 */
export const policyNodes = 100_000

/** The most objects and arrays in one input to a decoder. */
export const jsonNodes = 1_000_000

/** The most fields in the catalog of one Schema. */
export const catalogFields = 10_000

/** The most steps of one search for a value. */
export const searchSteps = 1_000_000

/** The most fields that one search for a value may test. */
export const searchFields = 256

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
