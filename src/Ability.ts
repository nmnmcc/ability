/**
 * Functional authorization primitives inspired by Effect and CASL.
 *
 * @since 0.1.0
 * @module
 */
import type * as Effect from "effect/Effect"
import type * as Pipeable from "effect/Pipeable"
import * as internal from "./internal/ability"

/**
 * @since 0.1.0
 * @category Type Ids
 */
export const TypeId = internal.TypeId

/**
 * @since 0.1.0
 * @category Type Ids
 */
export type TypeId = typeof TypeId

/**
 * @since 0.1.0
 * @category Models
 */
export type SubjectMap = Readonly<Record<string, object>>

/**
 * @since 0.1.0
 * @category Models
 */
export type SubjectName<Subjects extends SubjectMap> = string & keyof Subjects

/**
 * @since 0.1.0
 * @category Models
 */
export type FieldOf<Subject> = string & keyof Subject

/**
 * @since 0.1.0
 * @category Models
 */
export type RuleKind = "Allow" | "Deny"

/**
 * @since 0.1.0
 * @category Models
 */
export type Predicate<Subject, E = never, R = never> = (
  subject: Subject
) => boolean | Effect.Effect<boolean, E, R>

/**
 * @since 0.1.0
 * @category Models
 */
export interface RuleOptions<Subject, Fields extends string, E = never, R = never> {
  readonly fields?: ReadonlyArray<Fields>
  readonly when?: Predicate<Subject, E, R>
  readonly reason?: string
}

/**
 * @since 0.1.0
 * @category Models
 */
export interface Rule<
  Kind extends RuleKind,
  Action extends string,
  Name extends string,
  Subject,
  Fields extends string,
  E,
  R
> {
  readonly _tag: Kind
  readonly action: Action
  readonly subject: Name
  readonly fields?: ReadonlyArray<Fields>
  readonly when?: Predicate<Subject, E, R>
  readonly reason?: string
}

/**
 * @since 0.1.0
 * @category Models
 */
export type AnyRule = Rule<RuleKind, string, string, any, string, any, any>

/**
 * @since 0.1.0
 * @category Models
 */
export interface Ability<
  Subjects extends SubjectMap,
  Rules extends AnyRule = never
> extends Pipeable.Pipeable {
  readonly [TypeId]: TypeId
  readonly rules: ReadonlyArray<Rules>
  readonly _Subjects?: (_: never) => Subjects
  readonly _Rules?: (_: never) => Rules
}

/**
 * @since 0.1.0
 * @category Models
 */
export interface Builder<Subjects extends SubjectMap> {
  readonly allow: <
    const Action extends string,
    const Name extends SubjectName<Subjects>,
    const Fields extends FieldOf<Subjects[Name]> = FieldOf<Subjects[Name]>,
    E = never,
    R = never
  >(
    action: Action,
    subject: Name,
    options?: RuleOptions<Subjects[Name], Fields, E, R>
  ) => Effect.Effect<Rule<"Allow", Action, Name, Subjects[Name], Fields, E, R>>

  readonly deny: <
    const Action extends string,
    const Name extends SubjectName<Subjects>,
    const Fields extends FieldOf<Subjects[Name]> = FieldOf<Subjects[Name]>,
    E = never,
    R = never
  >(
    action: Action,
    subject: Name,
    options?: RuleOptions<Subjects[Name], Fields, E, R>
  ) => Effect.Effect<Rule<"Deny", Action, Name, Subjects[Name], Fields, E, R>>
}

type YieldableError<Eff> = Eff extends Effect.Yieldable<any, any, infer E, any> ? E : never
type YieldableServices<Eff> = Eff extends Effect.Yieldable<any, any, any, infer R> ? R : never
type YieldableRule<Eff> = Extract<Effect.Yieldable.Success<Eff>, AnyRule>

type RuleFields<Rules> = Rules extends Rule<any, any, any, any, infer Fields, any, any> ? Fields : never
type RuleError<Rules> = Rules extends Rule<any, any, any, any, any, infer E, any> ? E : never
type RuleServices<Rules> = Rules extends Rule<any, any, any, any, any, any, infer R> ? R : never
type MatchingRules<Rules, Request> = Rules extends AnyRule ? Request extends {
    readonly action: Rules["action"]
    readonly subject: Rules["subject"]
  } ? Rules
  : never
  : never

/**
 * @since 0.1.0
 * @category Models
 */
export type CheckRequest<
  Subjects extends SubjectMap,
  Rules extends AnyRule
> = Rules extends AnyRule ? {
    readonly action: Rules["action"]
    readonly subject: Rules["subject"] & SubjectName<Subjects>
    readonly value?: Subjects[Rules["subject"] & SubjectName<Subjects>]
    readonly field?: RuleFields<Rules>
  }
  : never

/**
 * @since 0.1.0
 * @category Errors
 */
export const AuthorizationError = internal.AuthorizationError

/**
 * @since 0.1.0
 * @category Errors
 */
export type AuthorizationError = internal.AuthorizationError

/**
 * Defines an immutable Ability from a generator-based rule program.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const define: <Subjects extends SubjectMap>() => <
  Eff extends Effect.Yieldable<any, any, any, any>,
  A
>(
  body: (builder: Builder<Subjects>) => Generator<Eff, A, never>
) => Effect.Effect<Ability<Subjects, YieldableRule<Eff>>, YieldableError<Eff>, YieldableServices<Eff>> =
  internal.define

/**
 * Constructs an Ability directly from rules.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const make: <Subjects extends SubjectMap, Rules extends AnyRule>(
  rules: Iterable<Rules>
) => Ability<Subjects, Rules> = internal.make

/**
 * Checks a request and fails with `AuthorizationError` when no allow rule wins.
 *
 * @since 0.1.0
 * @category Combinators
 */
export const check: {
  <
    Subjects extends SubjectMap,
    Rules extends AnyRule,
    const Request extends CheckRequest<Subjects, Rules>
  >(
    request: Request
  ): (
    self: Ability<Subjects, Rules>
  ) => Effect.Effect<
    void,
    AuthorizationError | RuleError<MatchingRules<Rules, Request>>,
    RuleServices<MatchingRules<Rules, Request>>
  >
  <
    Subjects extends SubjectMap,
    Rules extends AnyRule,
    const Request extends CheckRequest<Subjects, Rules>
  >(
    self: Ability<Subjects, Rules>,
    request: Request
  ): Effect.Effect<
    void,
    AuthorizationError | RuleError<MatchingRules<Rules, Request>>,
    RuleServices<MatchingRules<Rules, Request>>
  >
} = internal.check

/**
 * Returns whether a request is allowed. Predicate failures remain typed errors.
 *
 * @since 0.1.0
 * @category Combinators
 */
export const allows: {
  <
    Subjects extends SubjectMap,
    Rules extends AnyRule,
    const Request extends CheckRequest<Subjects, Rules>
  >(
    request: Request
  ): (
    self: Ability<Subjects, Rules>
  ) => Effect.Effect<boolean, RuleError<MatchingRules<Rules, Request>>, RuleServices<MatchingRules<Rules, Request>>>
  <
    Subjects extends SubjectMap,
    Rules extends AnyRule,
    const Request extends CheckRequest<Subjects, Rules>
  >(
    self: Ability<Subjects, Rules>,
    request: Request
  ): Effect.Effect<boolean, RuleError<MatchingRules<Rules, Request>>, RuleServices<MatchingRules<Rules, Request>>>
} = internal.allows
