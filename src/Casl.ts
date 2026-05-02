/**
 * CASL compatibility exports and adapters.
 *
 * This module re-exports the official `@casl/ability` API and provides a
 * adapter from this package's immutable Effect-style abilities to CASL Mongo
 * abilities.
 *
 * @since 0.1.0
 * @module
 */
import {createMongoAbility as caslCreateMongoAbility, detectSubjectType as caslDetectSubjectType} from "@casl/ability"
import type {MongoAbility, RawRule as CaslRawRule} from "@casl/ability"
import * as Effect from "effect/Effect"
import * as CoreAbility from "./Ability.js"

export {
  Ability,
  AbilityBuilder,
  ForbiddenError,
  PureAbility,
  buildMongoQueryMatcher,
  createAliasResolver,
  createMongoAbility,
  defineAbility,
  detectSubjectType,
  fieldPatternMatcher,
  mongoQueryMatcher,
  subject,
  wrapArray
} from "@casl/ability"

export type {
  Abilities,
  AbilityClass,
  AbilityOptions,
  AbilityOptionsOf,
  AbilityParameters,
  AbilityTuple,
  AnyAbility,
  AnyMongoAbility,
  CanParameters,
  ConditionsMatcher,
  CreateAbility,
  ExtractSubjectType,
  FieldMatcher,
  ForcedSubject,
  Generics,
  InferSubjects,
  MatchConditions,
  MatchField,
  MongoAbility,
  MongoQuery,
  RawRule,
  RawRuleOf,
  Rule,
  RuleOf,
  RuleOptions,
  Subject,
  SubjectClass,
  SubjectType
} from "@casl/ability"

type RuntimeCaslAbility = MongoAbility<[string, string | object], any>
type RuntimeCaslRawRule = CaslRawRule<[string, string], any>

const anyAction = "manage" as const
const anySubject = "all" as const

const copySingleOrArray = <A>(value: CoreAbility.SingleOrReadonlyArray<A>): A | Array<A> =>
  Array.isArray(value) ? Array.from(value as ReadonlyArray<A>) : (value as A)

const toCaslRawRule = (rule: CoreAbility.RawRule): RuntimeCaslRawRule => {
  const raw: {
    action: string | Array<string>
    subject: string | Array<string>
    fields?: string | Array<string>
    conditions?: unknown
    inverted?: boolean
    reason?: string
  } = {
    action: copySingleOrArray(rule.action),
    subject: copySingleOrArray(rule.subject)
  }
  if (rule.fields !== undefined) {
    raw.fields = copySingleOrArray(rule.fields)
  }
  if (rule.conditions !== undefined) {
    raw.conditions = rule.conditions
  }
  if (rule.inverted === true) {
    raw.inverted = true
  }
  if (rule.reason !== undefined) {
    raw.reason = rule.reason
  }
  return raw as RuntimeCaslRawRule
}

/**
 * Converts an Effect-style Ability into an official CASL Mongo ability.
 *
 * @since 0.1.0
 * @category Conversions
 */
export const toMongoAbility = <
  Subjects extends CoreAbility.SubjectMap,
  Rules extends CoreAbility.AnyRule,
  Aliases extends CoreAbility.ActionAliases
>(
  self: CoreAbility.Ability<Subjects, Rules, Aliases>
): Effect.Effect<RuntimeCaslAbility> => {
  const resolveAction = CoreAbility.createAliasResolver(self.options.actionAliases ?? {})
  return Effect.map(CoreAbility.toRawRules(self), (rules) =>
    caslCreateMongoAbility<[string, string | object], any>(Array.from(rules, toCaslRawRule), {
      anyAction,
      anySubjectType: anySubject,
      detectSubjectType: (subject) => {
        if (CoreAbility.isSubject(subject)) {
          return subject.subject
        }
        const value = CoreAbility.unwrapSubject(subject)
        if (self.options.detectSubjectType !== undefined && typeof value === "object" && value !== null) {
          return self.options.detectSubjectType(value)
        }
        return caslDetectSubjectType(value as never) as string
      },
      resolveAction: (action) => resolveAction(action) as Array<string>
    })
  )
}
