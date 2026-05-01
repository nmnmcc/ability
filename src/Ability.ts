/**
 * Functional authorization primitives inspired by Effect and CASL.
 *
 * @since 0.1.0
 * @module
 */
import type { MongoQuery } from "@ucast/mongo2js"
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
 * @category Type Ids
 */
export const SubjectTypeId = internal.SubjectTypeId

/**
 * @since 0.1.0
 * @category Type Ids
 */
export type SubjectTypeId = typeof SubjectTypeId

/**
 * @since 0.1.0
 * @category Models
 */
export type SingleOrReadonlyArray<A> = A | ReadonlyArray<A>

/**
 * @since 0.1.0
 * @category Models
 */
export type AnyAction = "manage"

/**
 * @since 0.1.0
 * @category Models
 */
export type AnySubject = "all"

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
export type RuleSubject<Subjects extends SubjectMap> = SubjectName<Subjects> | AnySubject

/**
 * @since 0.1.0
 * @category Models
 */
export type SubjectUnion<Subjects extends SubjectMap> = Subjects[SubjectName<Subjects>]

type Primitive = string | number | boolean | bigint | symbol | null | undefined | Function | ReadonlyArray<any>
type PreviousDepth = [never, 0, 1, 2, 3, 4, 5]
type FieldPathInternal<Subject, Depth extends number> = [Depth] extends [never] ? never
  : Subject extends Primitive ? never
  : Subject extends object ? {
      [Key in keyof Subject & string]: Subject[Key] extends Primitive ? Key
        : Key | `${Key}.${FieldPathInternal<Subject[Key], PreviousDepth[Depth]>}`
    }[keyof Subject & string]
  : never

/**
 * Dot-path field names for a subject. The recursion depth is intentionally
 * bounded to keep public type-checking predictable.
 *
 * @since 0.1.0
 * @category Models
 */
export type FieldPath<Subject> = FieldPathInternal<Subject, 5>

/**
 * @since 0.1.0
 * @category Models
 */
export type FieldPattern = `${string}*${string}`

/**
 * @since 0.1.0
 * @category Models
 */
export type FieldOf<Subject> = string & (FieldPath<Subject> | FieldPattern)

/**
 * @since 0.1.0
 * @category Models
 */
export type MongoCondition<Subject extends object> = MongoQuery<Subject> & Readonly<Record<string, unknown>>

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
export interface RuleOptions<Subject extends object, Fields extends string, E = never, R = never> {
  readonly fields?: SingleOrReadonlyArray<Fields>
  readonly conditions?: MongoCondition<Subject>
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
  Subject extends object,
  Fields extends string,
  E,
  R
> extends Pipeable.Pipeable, Effect.Yieldable<Rule<Kind, Action, Name, Subject, Fields, E, R>, Rule<Kind, Action, Name, Subject, Fields, E, R>> {
  readonly _tag: Kind
  readonly action: SingleOrReadonlyArray<Action>
  readonly subject: SingleOrReadonlyArray<Name>
  readonly fields?: ReadonlyArray<Fields>
  readonly conditions?: MongoCondition<Subject>
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
export interface TypedSubject<Name extends string, Value extends object> extends Pipeable.Pipeable {
  readonly [SubjectTypeId]: SubjectTypeId
  readonly _tag: "Subject"
  readonly subject: Name
  readonly value: Value
}

/**
 * @since 0.1.0
 * @category Models
 */
export type DetectSubjectType<Subjects extends SubjectMap> = (value: object) => SubjectName<Subjects>

/**
 * @since 0.1.0
 * @category Models
 */
export interface AbilityOptions<Subjects extends SubjectMap> {
  readonly detectSubjectType?: DetectSubjectType<Subjects>
}

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
  readonly options: AbilityOptions<Subjects>
  readonly _Subjects?: (_: never) => Subjects
  readonly _Rules?: (_: never) => Rules
}

type ElementOf<A> = A extends ReadonlyArray<infer B> ? B : A
type SubjectFor<Subjects extends SubjectMap, Name> = Name extends AnySubject ? SubjectUnion<Subjects>
  : Name extends SubjectName<Subjects> ? Subjects[Name]
  : never

/**
 * @since 0.1.0
 * @category Models
 */
export interface Builder<Subjects extends SubjectMap> {
  readonly allow: <
    const Action extends SingleOrReadonlyArray<string>,
    const Name extends SingleOrReadonlyArray<RuleSubject<Subjects>>,
    const Fields extends FieldOf<SubjectFor<Subjects, ElementOf<Name>> & object> = FieldOf<SubjectFor<Subjects, ElementOf<Name>> & object>,
    E = never,
    R = never
  >(
    action: Action,
    subject: Name,
    options?: RuleOptions<SubjectFor<Subjects, ElementOf<Name>> & object, Fields, E, R>
  ) => Rule<"Allow", ElementOf<Action> & string, ElementOf<Name> & string, SubjectFor<Subjects, ElementOf<Name>> & object, Fields, E, R>

  readonly deny: <
    const Action extends SingleOrReadonlyArray<string>,
    const Name extends SingleOrReadonlyArray<RuleSubject<Subjects>>,
    const Fields extends FieldOf<SubjectFor<Subjects, ElementOf<Name>> & object> = FieldOf<SubjectFor<Subjects, ElementOf<Name>> & object>,
    E = never,
    R = never
  >(
    action: Action,
    subject: Name,
    options?: RuleOptions<SubjectFor<Subjects, ElementOf<Name>> & object, Fields, E, R>
  ) => Rule<"Deny", ElementOf<Action> & string, ElementOf<Name> & string, SubjectFor<Subjects, ElementOf<Name>> & object, Fields, E, R>
}

/**
 * @since 0.1.0
 * @category Models
 */
export interface RawRule<
  Action extends string = string,
  Name extends string = string,
  Fields extends string = string,
  Conditions = unknown
> {
  readonly action: SingleOrReadonlyArray<Action>
  readonly subject: SingleOrReadonlyArray<Name>
  readonly fields?: SingleOrReadonlyArray<Fields>
  readonly conditions?: Conditions
  readonly inverted?: boolean
  readonly reason?: string
}

type RuleAction<Rules> = Rules extends Rule<any, infer Action, any, any, any, any, any> ? Action : never
type RuleSubjectName<Rules> = Rules extends Rule<any, any, infer Name, any, any, any, any> ? Name : never
type RuleFields<Rules> = Rules extends Rule<any, any, any, any, infer Fields, any, any> ? Fields : never
type RuleError<Rules> = Rules extends Rule<any, any, any, any, any, infer E, any> ? E : never
type RuleServices<Rules> = Rules extends Rule<any, any, any, any, any, any, infer R> ? R : never

type ActionMatches<Rule, Action extends string> = Rule extends AnyRule ? Action extends RuleAction<Rule> ? Rule
  : AnyAction extends RuleAction<Rule> ? Rule
  : never
  : never
type SubjectMatches<Rule, Name extends string> = Rule extends AnyRule ? Name extends RuleSubjectName<Rule> ? Rule
  : AnySubject extends RuleSubjectName<Rule> ? Rule
  : never
  : never
type RulesMatching<Rules, Action extends string, Name extends string> = SubjectMatches<ActionMatches<Rules, Action>, Name>

type AllowedActions<Rules> = AnyAction extends RuleAction<Rules> ? string : RuleAction<Rules>
type AllowedSubjects<Subjects extends SubjectMap, Rules> = AnySubject extends RuleSubjectName<Rules> ? SubjectName<Subjects>
  : Extract<RuleSubjectName<Rules>, SubjectName<Subjects>>
type FieldFor<
  Subjects extends SubjectMap,
  Rules,
  Action extends string,
  Name extends SubjectName<Subjects>
> = RuleFields<RulesMatching<Rules, Action, Name>> extends infer Fields ? [Fields] extends [never] ? FieldOf<Subjects[Name]>
  : Extract<Fields, FieldPattern> extends never ? Fields & string
  : FieldOf<Subjects[Name]>
  : never

type ExplicitCheckRequest<
  Subjects extends SubjectMap,
  Rules extends AnyRule
> = AllowedSubjects<Subjects, Rules> extends infer Name ? Name extends SubjectName<Subjects>
    ? AllowedActions<Rules> extends infer Action ? Action extends string ? {
          readonly action: Action
          readonly subject: Name
          readonly value?: Subjects[Name] | TypedSubject<Name, Subjects[Name]>
          readonly field?: FieldFor<Subjects, Rules, Action, Name>
        }
      : never
      : never
    : never
  : never

type TypedSubjectCheckRequest<
  Subjects extends SubjectMap,
  Rules extends AnyRule
> = AllowedSubjects<Subjects, Rules> extends infer Name ? Name extends SubjectName<Subjects>
    ? AllowedActions<Rules> extends infer Action ? Action extends string ? {
          readonly action: Action
          readonly subject?: never
          readonly value: TypedSubject<Name, Subjects[Name]>
          readonly field?: FieldFor<Subjects, Rules, Action, Name>
        }
      : never
      : never
    : never
  : never

type DetectedSubjectCheckRequest<
  Subjects extends SubjectMap,
  Rules extends AnyRule
> = {
  readonly action: AllowedActions<Rules>
  readonly subject?: never
  readonly value: SubjectUnion<Subjects>
  readonly field?: string
}

/**
 * @since 0.1.0
 * @category Models
 */
export type CheckRequest<
  Subjects extends SubjectMap,
  Rules extends AnyRule
> = ExplicitCheckRequest<Subjects, Rules> | TypedSubjectCheckRequest<Subjects, Rules> | DetectedSubjectCheckRequest<Subjects, Rules>

type RequestAction<Request> = Request extends { readonly action: infer Action } ? Action & string : string
type RequestSubject<Request> = Request extends { readonly subject: infer Name } ? Name & string
  : Request extends { readonly value: TypedSubject<infer Name, any> } ? Name & string
  : string
type MatchingRules<Rules, Request> = RulesMatching<Rules, RequestAction<Request>, RequestSubject<Request>>

/**
 * @since 0.1.0
 * @category Models
 */
export interface ToRawRulesOptions {
  readonly strict?: boolean
}

/**
 * @since 0.1.0
 * @category Models
 */
export interface PermittedFieldsOptions<Rules extends AnyRule> {
  readonly fieldsFrom: (rule: Rules) => ReadonlyArray<string>
}

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
 * @since 0.1.0
 * @category Errors
 */
export const ConditionError = internal.ConditionError

/**
 * @since 0.1.0
 * @category Errors
 */
export type ConditionError = internal.ConditionError

/**
 * @since 0.1.0
 * @category Errors
 */
export const SerializationError = internal.SerializationError

/**
 * @since 0.1.0
 * @category Errors
 */
export type SerializationError = internal.SerializationError

/**
 * @since 0.1.0
 * @category Errors
 */
export const RawRuleError = internal.RawRuleError

/**
 * @since 0.1.0
 * @category Errors
 */
export type RawRuleError = internal.RawRuleError

/**
 * @since 0.1.0
 * @category Errors
 */
export const SubjectDetectionError = internal.SubjectDetectionError

/**
 * @since 0.1.0
 * @category Errors
 */
export type SubjectDetectionError = internal.SubjectDetectionError

/**
 * Defines an immutable Ability from a generator-based rule program.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const define: <Subjects extends SubjectMap>() => <
  Eff extends AnyRule,
  A
>(
  body: (builder: Builder<Subjects>) => Generator<Eff, A, any>,
  options?: AbilityOptions<Subjects>
) => Ability<Subjects, Eff> =
  internal.define

/**
 * Constructs an Ability directly from rules.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const make: <Subjects extends SubjectMap, Rules extends AnyRule>(
  rules: Iterable<Rules>,
  options?: AbilityOptions<Subjects>
) => Ability<Subjects, Rules> = internal.make

/**
 * Constructs an Ability from JSON-safe rules.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const fromRawRules: <Subjects extends SubjectMap>(
  rules: Iterable<RawRule<string, RuleSubject<Subjects>, string, MongoCondition<SubjectUnion<Subjects>>>>,
  options?: AbilityOptions<Subjects>
) => Effect.Effect<Ability<Subjects, AnyRule>, RawRuleError> =
  internal.fromRawRules

/**
 * Creates a pure typed subject wrapper without mutating the wrapped value.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const subject: <const Name extends string, Value extends object>(
  name: Name,
  value: Value
) => TypedSubject<Name, Value> =
  internal.subject

/**
 * Returns whether a value is a typed subject wrapper.
 *
 * @since 0.1.0
 * @category Guards
 */
export const isSubject: (value: unknown) => value is TypedSubject<string, object> =
  internal.isSubject

/**
 * Unwraps a typed subject wrapper.
 *
 * @since 0.1.0
 * @category Accessors
 */
export const unwrapSubject: <Value>(value: Value) => Value extends TypedSubject<any, infer Subject> ? Subject : Value =
  internal.unwrapSubject as never

/**
 * Detects a subject name for a value using an Ability's detection strategy.
 *
 * @since 0.1.0
 * @category Accessors
 */
export const detectSubjectType: <Subjects extends SubjectMap, Rules extends AnyRule>(
  self: Ability<Subjects, Rules>,
  value: object | TypedSubject<SubjectName<Subjects>, SubjectUnion<Subjects>>
) => Effect.Effect<SubjectName<Subjects>, SubjectDetectionError> =
  internal.detectSubjectType

/**
 * Converts an Ability to JSON-safe raw rules.
 *
 * @since 0.1.0
 * @category Conversions
 */
export const toRawRules: <Subjects extends SubjectMap, Rules extends AnyRule>(
  self: Ability<Subjects, Rules>,
  options?: ToRawRulesOptions
) => Effect.Effect<ReadonlyArray<RawRule>, SerializationError> =
  internal.toRawRules

/**
 * Checks a request and fails with `AuthorizationError` when the request is not authorized.
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
    AuthorizationError | ConditionError | SubjectDetectionError | RuleError<MatchingRules<Rules, Request>>,
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
    AuthorizationError | ConditionError | SubjectDetectionError | RuleError<MatchingRules<Rules, Request>>,
    RuleServices<MatchingRules<Rules, Request>>
  >
} = internal.check

/**
 * Computes fields permitted for a request.
 *
 * @since 0.1.0
 * @category Combinators
 */
export const permittedFields: {
  <
    Subjects extends SubjectMap,
    Rules extends AnyRule,
    const Request extends CheckRequest<Subjects, Rules>
  >(
    request: Request,
    options: PermittedFieldsOptions<Rules>
  ): (
    self: Ability<Subjects, Rules>
  ) => Effect.Effect<
    ReadonlyArray<string>,
    ConditionError | SubjectDetectionError | RuleError<MatchingRules<Rules, Request>>,
    RuleServices<MatchingRules<Rules, Request>>
  >
  <
    Subjects extends SubjectMap,
    Rules extends AnyRule,
    const Request extends CheckRequest<Subjects, Rules>
  >(
    self: Ability<Subjects, Rules>,
    request: Request,
    options: PermittedFieldsOptions<Rules>
  ): Effect.Effect<
    ReadonlyArray<string>,
    ConditionError | SubjectDetectionError | RuleError<MatchingRules<Rules, Request>>,
    RuleServices<MatchingRules<Rules, Request>>
  >
} = internal.permittedFields
