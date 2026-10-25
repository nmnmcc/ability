/**
 * The limits of the library. Each one keeps a walk, a decoder or a search
 * small, so no input can fill the stack or take a very long time. An input
 * past a limit is an error, with one form of message, as in "A condition has
 * 100001 nodes. The most is 100000.". In an `Authorizer`, such an error is
 * never a "yes".
 *
 * @stability stable
 * @since 2.0.0
 */
import * as Limits from "./internal/limits.ts"

/**
 * The most parts of a field path, as in `settings.model`. The types of the
 * field paths go to the same depth.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const fieldPathParts: number = Limits.fieldPathParts

/**
 * The most parts of a field pattern, as in `**.secret`.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const patternParts: number = Limits.patternParts

/**
 * The most nodes of one condition. A part that a condition uses in many
 * places counts for each place.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const conditionNodes: number = Limits.conditionNodes

/**
 * The most levels of one condition.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const conditionDepth: number = Limits.conditionDepth

/**
 * The most nodes of one residual condition.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const residualNodes: number = Limits.residualNodes

/**
 * The most levels of a policy tree.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const policyDepth: number = Limits.policyDepth

/**
 * The most nodes of a policy tree, with its rules and the nodes of their
 * conditions. A part that the tree uses in many places counts for each place.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const policyNodes: number = Limits.policyNodes

/**
 * The most objects and arrays in one input to the Schema of a policy or of a
 * condition.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const jsonNodes: number = Limits.jsonNodes

/**
 * The most fields in the catalog of one Schema.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const catalogFields: number = Limits.catalogFields

/**
 * The most steps of one search for a value, as in `Policy.coverage`. Past
 * it, the answer is `Unknown`.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const searchSteps: number = Limits.searchSteps

/**
 * The most fields that one search for a value may test. Past it, the answer
 * is `Unknown`.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const searchFields: number = Limits.searchFields

/**
 * The error when an input goes past a limit.
 *
 * @stability stable
 * @category errors
 * @since 2.0.0
 */
export const LimitExceeded: typeof Limits.LimitExceeded = Limits.LimitExceeded

/**
 * @stability stable
 * @category errors
 * @since 2.0.0
 */
export type LimitExceeded = Limits.LimitExceeded
