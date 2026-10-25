/**
 * The limits of the library. Each one keeps a decoder, a walk or a search
 * small, so no input can take a very long time or very much memory. An input
 * past a limit is an error, with one form of message, as in "A condition has
 * 1000001 nodes and values. The most is 1000000.". In an `Authorizer`, such
 * an error is never a "yes".
 *
 * The constants here are the defaults. A domain may set its own limits, up
 * to the {@link ceilings}: see `Domain.make`. A walk does not fill the stack
 * at any depth, and the levels of an input are at most its nodes, so there is
 * no limit of levels.
 *
 * @stability stable
 * @since 2.0.0
 */
import * as Internal from "./internal/limits.ts"

/**
 * The values of all the limits.
 *
 * @stability stable
 * @category models
 * @since 2.1.0
 */
export type Limits = Internal.Limits

/**
 * The limits of a domain that sets none.
 *
 * @stability stable
 * @category constants
 * @since 2.1.0
 */
export const defaults: Limits = Internal.defaults

/**
 * The most that a domain may set for each limit.
 *
 * @stability stable
 * @category constants
 * @since 2.1.0
 */
export const ceilings: Limits = Internal.ceilings

/**
 * The most parts of a field path, as in `settings.model`, by default. The
 * types check a path that you write up to about 1000 parts.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const fieldPathParts: number = Internal.fieldPathParts

/**
 * The most parts of a field pattern, as in `**.secret`.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const patternParts: number = Internal.patternParts

/**
 * The most nodes of one condition, with each value of an `In` or `Under`
 * test. A part that a condition uses in many places counts for each place.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const conditionNodes: number = Internal.conditionNodes

/**
 * There is no limit of the levels of a condition: a walk does not fill the
 * stack, and the levels are at most the nodes, which `conditionNodes`
 * limits.
 *
 * @deprecated Since 2.1.0, there is no such limit. The value is `Infinity`.
 * @stability deprecated
 * @category constants
 * @since 2.0.0
 */
export const conditionDepth: number = Number.POSITIVE_INFINITY

/**
 * The most nodes of one residual condition.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const residualNodes: number = Internal.residualNodes

/**
 * There is no limit of the levels of a policy tree: a walk does not fill the
 * stack, and the levels are at most the nodes, which `policyNodes` limits.
 *
 * @deprecated Since 2.1.0, there is no such limit. The value is `Infinity`.
 * @stability deprecated
 * @category constants
 * @since 2.0.0
 */
export const policyDepth: number = Number.POSITIVE_INFINITY

/**
 * The most nodes of a policy tree, with its rules and the nodes and values
 * of their conditions. A part that the tree uses in many places counts for
 * each place.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const policyNodes: number = Internal.policyNodes

/**
 * The most objects and arrays in one input to the Schema of a policy or of a
 * condition.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const jsonNodes: number = Internal.jsonNodes

/**
 * The most fields in the list of the fields of one Schema, as
 * `Policy.permittedFields` reads it.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const catalogFields: number = Internal.catalogFields

/**
 * The most steps of one search for a value, as in `Policy.coverage`. Past
 * it, the answer is `Unknown`. It is also the most steps of the checks of
 * the field patterns of one policy on every kind of their rules. Past it, the
 * policy does not load.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const searchSteps: number = Internal.searchSteps

/**
 * The most fields that one search for a value may test. Past it, the answer
 * is `Unknown`.
 *
 * @stability stable
 * @category constants
 * @since 2.0.0
 */
export const searchFields: number = Internal.searchFields

/**
 * The error when an input goes past a limit.
 *
 * @stability stable
 * @category errors
 * @since 2.0.0
 */
export const LimitExceeded: typeof Internal.LimitExceeded =
	Internal.LimitExceeded

/**
 * @stability stable
 * @category errors
 * @since 2.0.0
 */
export type LimitExceeded = Internal.LimitExceeded
