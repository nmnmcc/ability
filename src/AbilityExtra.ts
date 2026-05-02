/**
 * Extra helpers for serializing and transforming Ability rules.
 *
 * Mental model:
 * - `AbilityExtra` works with already-defined abilities and JSON-safe rules.
 * - Packing preserves rule structure while reducing wire size.
 * - Query helpers transform rule lists into caller-owned condition formats.
 *
 * Common tasks:
 * - Compact raw rules with {@link packRules} and {@link unpackRules}.
 * - Derive default fields from rule conditions with {@link rulesToFields}.
 * - Convert matching rules to logical conditions with {@link rulesToCondition}
 *   or {@link rulesToQuery}.
 *
 * Gotchas:
 * - Conversion callbacks may be synchronous or Effectful; synchronous throws are
 *   converted to `QueryGenerationError`.
 *
 * @since 0.1.0
 * @module
 */
import * as Effect from "effect/Effect"
import {dual} from "effect/Function"
import * as Ability from "./Ability.js"
import {cloneSerializable, isPlainObject} from "./internal/serializable.js"

/**
 * @since 0.1.0
 * @category Models
 */
export type PackRule<Rule extends Ability.RawRule = Ability.RawRule> = readonly [
  action: Rule["action"],
  subject: Rule["subject"],
  conditions?: Rule["conditions"] | 0,
  inverted?: 1 | 0,
  fields?: Rule["fields"] | 0,
  reason?: string
]

/**
 * @since 0.1.0
 * @category Models
 */
export interface RulesToConditionHooks<Query> {
  readonly and: (conditions: ReadonlyArray<Query>) => Query
  readonly or: (conditions: ReadonlyArray<Query>) => Query
  readonly not: (condition: Query) => Query
  readonly empty: () => Query
}

/**
 * @since 0.1.0
 * @category Models
 */
export type LogicalQuery<Query> =
  | Query
  | {
      readonly $and: ReadonlyArray<LogicalQuery<Query>>
    }
  | {
      readonly $or: ReadonlyArray<LogicalQuery<Query>>
    }
  | {
      readonly $not: LogicalQuery<Query>
    }

const forbiddenPathKeys = new Set(["__proto__", "constructor", "prototype"])

const setByPath = (object: Record<string, unknown>, path: string, value: unknown): void => {
  const keys = path.split(".")
  let cursor = object
  let index = 0

  while (index < keys.length - 1) {
    const key = keys[index]
    if (key === undefined || forbiddenPathKeys.has(key)) {
      return
    }

    const current = cursor[key]
    if (!isPlainObject(current)) {
      const next: Record<string, unknown> = {}
      cursor[key] = next
      cursor = next
    } else {
      cursor = current as Record<string, unknown>
    }
    index = index + 1
  }

  const lastKey = keys[keys.length - 1]
  if (lastKey !== undefined && !forbiddenPathKeys.has(lastKey)) {
    cursor[lastKey] = value
  }
}

const packRule = <Rule extends Ability.RawRule>(rule: Rule): PackRule<Rule> => {
  const packed: Array<unknown> = [
    cloneSerializable(rule.action),
    cloneSerializable(rule.subject),
    rule.conditions === undefined ? 0 : cloneSerializable(rule.conditions),
    rule.inverted === true ? 1 : 0,
    rule.fields === undefined ? 0 : cloneSerializable(rule.fields),
    rule.reason ?? ""
  ]

  while (
    packed.length > 2 &&
    (packed[packed.length - 1] === 0 || packed[packed.length - 1] === "" || packed[packed.length - 1] === undefined)
  ) {
    packed.pop()
  }

  return Object.freeze(packed) as unknown as PackRule<Rule>
}

/**
 * Packs JSON-safe raw rules into a compact tuple format.
 *
 * @since 0.1.0
 * @category Conversions
 */
export const packRules = <Rule extends Ability.RawRule>(rules: Iterable<Rule>): ReadonlyArray<PackRule<Rule>> =>
  Object.freeze(Array.from(rules, packRule))

const unpackRule = <Rule extends Ability.RawRule>(packed: PackRule<Rule>): Rule => {
  const [action, subject, conditions, inverted, fields, reason] = packed
  const rule: {
    action: Rule["action"]
    subject: Rule["subject"]
    conditions?: Rule["conditions"]
    inverted?: boolean
    fields?: Rule["fields"]
    reason?: string
  } = {
    action: cloneSerializable(action) as Rule["action"],
    subject: cloneSerializable(subject) as Rule["subject"]
  }

  if (conditions !== undefined && conditions !== 0) {
    rule.conditions = cloneSerializable(conditions) as Rule["conditions"]
  }
  if (inverted === 1) {
    rule.inverted = true
  }
  if (fields !== undefined && fields !== 0) {
    rule.fields = cloneSerializable(fields) as Rule["fields"]
  }
  if (reason !== undefined && reason !== "") {
    rule.reason = reason
  }

  return Object.freeze(rule) as Rule
}

/**
 * Unpacks compact raw rules produced by `packRules`.
 *
 * @since 0.1.0
 * @category Conversions
 */
export const unpackRules = <Rule extends Ability.RawRule = Ability.RawRule>(
  rules: Iterable<PackRule<Rule>>
): ReadonlyArray<Rule> => Object.freeze(Array.from(rules, unpackRule))

const queryGenerationError = (reason: string, ruleIndex?: number, cause?: unknown): Ability.QueryGenerationError => {
  const error: {
    reason: string
    ruleIndex?: number
    cause?: unknown
  } = {
    reason
  }
  if (ruleIndex !== undefined) {
    error.ruleIndex = ruleIndex
  }
  if (cause !== undefined) {
    error.cause = cause
  }
  return new Ability.QueryGenerationError(error)
}

/**
 * Extracts scalar condition values as default fields.
 *
 * @since 0.1.0
 * @category Conversions
 */
const rulesToFieldsEffect = Effect.fnUntraced(function* <
  Subjects extends Ability.SubjectMap,
  Rules extends Ability.AnyRule,
  Aliases extends Ability.ActionAliases,
  const Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases>
>(
  self: Ability.Ability<Subjects, Rules, Aliases>,
  request: Request
): Effect.fn.Return<Readonly<Record<string, unknown>>, Ability.SubjectDetectionError | Ability.QueryGenerationError> {
  const rules = (yield* Ability.rulesFor(self, request)) as ReadonlyArray<Ability.AnyRule>
  const fields: Record<string, unknown> = {}
  let index = 0

  for (const rule of rules) {
    if (rule._tag === "Allow" && rule.conditions !== undefined) {
      for (const key of Object.keys(rule.conditions as Record<string, unknown>)) {
        const value = (rule.conditions as Record<string, unknown>)[key]
        if (!isPlainObject(value)) {
          setByPath(fields, key, value)
        }
      }
    }
    index = index + 1
  }

  return Object.freeze(fields)
})

/**
 * Extracts scalar condition values as default fields.
 *
 * @since 0.1.0
 * @category Conversions
 */
export const rulesToFields: {
  <const Request>(
    request: Request
  ): <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule, Aliases extends Ability.ActionAliases>(
    self: Ability.Ability<Subjects, Rules, Aliases> &
      (Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases> ? unknown : never)
  ) => Effect.Effect<Readonly<Record<string, unknown>>, Ability.QueryGenerationError | Ability.SubjectDetectionError>
  <
    Subjects extends Ability.SubjectMap,
    Rules extends Ability.AnyRule,
    Aliases extends Ability.ActionAliases,
    const Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases>
  >(
    self: Ability.Ability<Subjects, Rules, Aliases>,
    request: Request
  ): Effect.Effect<Readonly<Record<string, unknown>>, Ability.QueryGenerationError | Ability.SubjectDetectionError>
} = dual(2, rulesToFieldsEffect)

const convertRule = <Rule extends Ability.AnyRule, Query, E, R>(
  rule: Rule,
  convert: (rule: Rule) => Query | Effect.Effect<Query, E, R>,
  ruleIndex: number
): Effect.Effect<Query, Ability.QueryGenerationError | E, R> =>
  Effect.flatMap(
    Effect.try({
      try: () => convert(rule),
      catch: (cause) => queryGenerationError("Rule conversion failed", ruleIndex, cause)
    }),
    (result) => (Effect.isEffect(result) ? result : Effect.succeed(result))
  )

/**
 * Converts rules into a caller-defined logical condition.
 *
 * @since 0.1.0
 * @category Conversions
 */
const rulesToConditionEffect = Effect.fnUntraced(function* <
  Subjects extends Ability.SubjectMap,
  Rules extends Ability.AnyRule,
  Aliases extends Ability.ActionAliases,
  const Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases>,
  Query,
  E = never,
  R = never
>(
  self: Ability.Ability<Subjects, Rules, Aliases>,
  request: Request,
  convert: (rule: Rules) => Query | Effect.Effect<Query, E, R>,
  hooks: RulesToConditionHooks<Query>
): Effect.fn.Return<Query | null, Ability.SubjectDetectionError | Ability.QueryGenerationError | E, R> {
  const rules = yield* Ability.rulesFor(self, request)
  const higherDenyBounds: Array<Query> = []
  const orConditions: Array<Query> = []
  let hasUnconditionalAllow = false
  let index = 0

  while (index < rules.length) {
    const rule = rules[index] as Rules

    if (rule._tag === "Deny") {
      if (rule.conditions === undefined) {
        break
      }
      const condition = yield* convertRule(rule, convert, index)
      higherDenyBounds.push(hooks.not(condition))
    } else {
      if (rule.conditions === undefined) {
        hasUnconditionalAllow = true
        break
      }
      const condition = yield* convertRule(rule, convert, index)
      orConditions.push(higherDenyBounds.length === 0 ? condition : hooks.and([condition, ...higherDenyBounds]))
    }

    index = index + 1
  }

  if (hasUnconditionalAllow) {
    if (higherDenyBounds.length === 0) {
      return hooks.empty()
    }
    if (orConditions.length === 0) {
      return hooks.and(higherDenyBounds)
    }
    orConditions.push(hooks.and(higherDenyBounds))
  }

  if (orConditions.length === 0) {
    return null
  }
  return hooks.or(orConditions)
})

/**
 * Converts rules into a caller-defined logical condition.
 *
 * @since 0.1.0
 * @category Conversions
 */
export const rulesToCondition: {
  <const Request, Query, E = never, R = never>(
    request: Request,
    convert: (rule: Ability.AnyRule) => Query | Effect.Effect<Query, E, R>,
    hooks: RulesToConditionHooks<Query>
  ): <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule, Aliases extends Ability.ActionAliases>(
    self: Ability.Ability<Subjects, Rules, Aliases> &
      (Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases> ? unknown : never)
  ) => Effect.Effect<Query | null, Ability.QueryGenerationError | Ability.SubjectDetectionError | E, R>
  <
    Subjects extends Ability.SubjectMap,
    Rules extends Ability.AnyRule,
    Aliases extends Ability.ActionAliases,
    const Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases>,
    Query,
    E = never,
    R = never
  >(
    self: Ability.Ability<Subjects, Rules, Aliases>,
    request: Request,
    convert: (rule: Rules) => Query | Effect.Effect<Query, E, R>,
    hooks: RulesToConditionHooks<Query>
  ): Effect.Effect<Query | null, Ability.QueryGenerationError | Ability.SubjectDetectionError | E, R>
} = dual(4, rulesToConditionEffect)

/**
 * Converts rules into a small generic logical query object.
 *
 * @since 0.1.0
 * @category Conversions
 */
const rulesToQueryEffect = Effect.fnUntraced(function* <
  Subjects extends Ability.SubjectMap,
  Rules extends Ability.AnyRule,
  Aliases extends Ability.ActionAliases,
  const Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases>,
  Query,
  E = never,
  R = never
>(
  self: Ability.Ability<Subjects, Rules, Aliases>,
  request: Request,
  convert: (rule: Rules) => Query | Effect.Effect<Query, E, R>
): Effect.fn.Return<LogicalQuery<Query> | null, Ability.SubjectDetectionError | Ability.QueryGenerationError | E, R> {
  const logicalConvert = (rule: Rules): LogicalQuery<Query> | Effect.Effect<LogicalQuery<Query>, E, R> => {
    const result = convert(rule)
    return Effect.isEffect(result)
      ? (result as Effect.Effect<LogicalQuery<Query>, E, R>)
      : (result as LogicalQuery<Query>)
  }

  return yield* rulesToConditionEffect(self, request, logicalConvert, {
    and: (conditions) => ({$and: conditions}),
    or: (conditions) => ({$or: conditions}),
    not: (condition) => ({$not: condition}),
    empty: () => ({}) as LogicalQuery<Query>
  })
})

/**
 * Converts rules into a small generic logical query object.
 *
 * @since 0.1.0
 * @category Conversions
 */
export const rulesToQuery: {
  <const Request, Query, E = never, R = never>(
    request: Request,
    convert: (rule: Ability.AnyRule) => Query | Effect.Effect<Query, E, R>
  ): <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule, Aliases extends Ability.ActionAliases>(
    self: Ability.Ability<Subjects, Rules, Aliases> &
      (Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases> ? unknown : never)
  ) => Effect.Effect<LogicalQuery<Query> | null, Ability.QueryGenerationError | Ability.SubjectDetectionError | E, R>
  <
    Subjects extends Ability.SubjectMap,
    Rules extends Ability.AnyRule,
    Aliases extends Ability.ActionAliases,
    const Request extends Ability.RuleQueryRequest<Subjects, Rules, Aliases>,
    Query,
    E = never,
    R = never
  >(
    self: Ability.Ability<Subjects, Rules, Aliases>,
    request: Request,
    convert: (rule: Rules) => Query | Effect.Effect<Query, E, R>
  ): Effect.Effect<LogicalQuery<Query> | null, Ability.QueryGenerationError | Ability.SubjectDetectionError | E, R>
} = dual(3, rulesToQueryEffect)
