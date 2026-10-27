/**
 * Fixed bounds for data, walks, and searches. These values are part of the
 * supported input contract. They can not be changed by a domain.
 *
 * @stability stable
 * @since 3.0.0
 */
import * as Internal from "./internal/limits.ts"

/**
 * The most parts of a field path.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const fieldPathParts: number = Internal.fieldPathParts

/**
 * The most levels of a condition or a residual.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const conditionDepth: number = Internal.conditionDepth

/**
 * The most levels of a policy tree.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const policyDepth: number = Internal.policyDepth

/**
 * The most levels of JSON meta.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const metaDepth: number = Internal.metaDepth

/**
 * The most structural units of one condition.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const conditionNodes: number = Internal.conditionNodes

/**
 * The most structural units of one residual.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const residualNodes: number = Internal.residualNodes

/**
 * The most structural units of one policy.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const policyNodes: number = Internal.policyNodes

/**
 * The most fields in one Schema field list.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const catalogFields: number = Internal.catalogFields

/**
 * The most UTF-16 code units in JSON text.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const jsonTextLength: number = Internal.jsonTextLength

/**
 * The most levels of JSON containers.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const jsonDepth: number = Internal.jsonDepth

/**
 * The most values in a JSON input.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const jsonItems: number = Internal.jsonItems

/**
 * The most fields in one analysis.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const searchFields: number = Internal.searchFields

/**
 * The most steps in one analysis.
 *
 * @stability stable
 * @category constants
 * @since 3.0.0
 */
export const searchSteps: number = Internal.searchSteps

/**
 * An input passed a fixed bound.
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
