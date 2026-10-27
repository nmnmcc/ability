/** Fixed bounds for data, walks, and searches. */
import * as Schema from "effect/Schema"

export const fieldPathParts = 5
export const conditionDepth = 64
export const policyDepth = 32
export const metaDepth = 16
export const conditionNodes = 10_000
export const residualNodes = 10_000
export const policyNodes = 10_000
export const catalogFields = 1_000
export const jsonTextLength = 1_000_000
export const jsonDepth = 256
export const jsonItems = 100_000
export const searchFields = 16
export const searchSteps = 100_000

/**
 * The error when an input goes past a limit. It names the limit, the size of
 * the input, and the most that the limit takes.
 */
export class LimitExceeded extends Schema.TaggedError<
	LimitExceeded,
	{ readonly brand: unique symbol }
>("@nmnmcc/ability/Limits/LimitExceeded")("LimitExceeded", {
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
