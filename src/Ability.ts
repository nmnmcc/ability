/**
 * Authorization tools in the style of Effect and CASL. Authorization means the
 * work of deciding if a person may do an act.
 *
 * How it works:
 * - An `Ability` is a list of `Rule` values. The list is in order, and it does
 *   not change.
 * - You give rules in a generator function. Each `yield* ability.allow(...)`
 *   adds one rule. `Ability.define` still gives its result at once.
 * - `Ability.check` is the only function that makes the decision. It gives
 *   `void` when the answer is yes. It fails in the Effect error channel when
 *   the answer is no.
 *
 * Common work:
 * - Make rules with {@link define}.
 * - Check a request with {@link check}.
 * - Put a subject name on a plain value with {@link subject} when the code
 *   cannot get the subject from the value.
 * - Change rules into plain JSON data and back with {@link toRawRules} and
 *   {@link fromRawRules}.
 *
 * Take care:
 * - The last rule that matches wins.
 *
 * @since 0.1.0
 * @module
 */
import type { MongoQuery } from "@casl/ability"
import type * as Equal from "effect/Equal"
import type * as Effect from "effect/Effect"
import type * as Inspectable from "effect/Inspectable"
import type * as Pipeable from "effect/Pipeable"
import * as internal from "./internal/ability.ts"

/**
 * @since 0.1.0
 * @category Type Ids
 */
export const TypeId: typeof internal.TypeId = internal.TypeId

/**
 * @since 0.1.0
 * @category Type Ids
 */
export type TypeId = typeof TypeId

/**
 * @since 0.1.0
 * @category Type Ids
 */
export const SubjectTypeId: typeof internal.SubjectTypeId =
	internal.SubjectTypeId

/**
 * @since 0.1.0
 * @category Type Ids
 */
export type SubjectTypeId = typeof SubjectTypeId

/**
 * The special key that marks `Rule` values.
 *
 * @since 0.1.0
 * @category Type Ids
 */
export const RuleTypeId: typeof internal.RuleTypeId = internal.RuleTypeId

/**
 * @since 0.1.0
 * @category Type Ids
 */
export type RuleTypeId = typeof RuleTypeId

/**
 * @since 0.1.0
 * @category Models
 */
export type SingleOrReadonlyArray<A> = A | ReadonlyArray<A>

/**
 * @since 0.1.0
 * @category Models
 */
export type ActionAliases = Readonly<
	Record<string, SingleOrReadonlyArray<string>>
>

/**
 * @since 0.1.0
 * @category Models
 */
export type ActionResolver = (
	action: SingleOrReadonlyArray<string>,
) => ReadonlyArray<string>

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
export type RuleSubject<Subjects extends SubjectMap> =
	SubjectName<Subjects> | AnySubject

/**
 * @since 0.1.0
 * @category Models
 */
export type SubjectUnion<Subjects extends SubjectMap> =
	Subjects[SubjectName<Subjects>]

type Primitive =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| Function
	| ReadonlyArray<unknown>
type PreviousDepth = [never, 0, 1, 2, 3, 4, 5]
type FieldPathInternal<Subject, Depth extends number> = [Depth] extends [never]
	? never
	: Subject extends Primitive
		? never
		: Subject extends object
			? {
					[Key in keyof Subject & string]: Subject[Key] extends Primitive
						? Key
						: | Key
							| `${Key}.${FieldPathInternal<Subject[Key], PreviousDepth[Depth]>}`
				}[keyof Subject & string]
			: never

/**
 * The field names of a subject, as paths with dots. The type goes down only
 * five levels, so type checking stays fast.
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

export type MongoCondition<Subject extends object> = MongoQuery<Subject>

/**
 * @since 0.1.0
 * @category Models
 */
export type RuleKind = "Allow" | "Deny"

/**
 * @since 0.1.0
 * @category Models
 */
export interface RuleOptions<Subject extends object, Fields extends string> {
	readonly fields?: SingleOrReadonlyArray<Fields>
	readonly conditions?: MongoCondition<Subject>
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
>
	extends Equal.Equal, Inspectable.Inspectable, Pipeable.Pipeable {
	readonly [RuleTypeId]: RuleTypeId
	[Symbol.iterator](): Generator<
		Rule<Kind, Action, Name, Subject, Fields>,
		Rule<Kind, Action, Name, Subject, Fields>,
		unknown
	>
	readonly _tag: Kind
	readonly action: SingleOrReadonlyArray<Action>
	readonly subject: SingleOrReadonlyArray<Name>
	readonly fields?: ReadonlyArray<Fields>
	readonly conditions?: MongoCondition<Subject>
	readonly reason?: string
}

/**
 * @since 0.1.0
 * @category Models
 */
export type AnyRule = Rule<RuleKind, string, string, any, string>

/**
 * @since 0.1.0
 * @category Models
 */
export interface TypedSubject<Name extends string, Value extends object>
	extends Equal.Equal, Inspectable.Inspectable, Pipeable.Pipeable {
	readonly [SubjectTypeId]: SubjectTypeId
	readonly _tag: "Subject"
	readonly subject: Name
	readonly value: Value
}

/**
 * @since 0.1.0
 * @category Models
 */
export type DetectSubjectType<Subjects extends SubjectMap> = (
	value: object,
) => SubjectName<Subjects>

/**
 * @since 0.1.0
 * @category Models
 */
export interface AbilityOptions<
	Subjects extends SubjectMap,
	Aliases extends ActionAliases = {},
> {
	readonly detectSubjectType?: DetectSubjectType<Subjects>
	readonly actionAliases?: Aliases
}

/**
 * @since 0.1.0
 * @category Models
 */
export interface Ability<
	Subjects extends SubjectMap,
	Rules extends AnyRule = never,
	Aliases extends ActionAliases = {},
>
	extends Equal.Equal, Inspectable.Inspectable, Pipeable.Pipeable {
	readonly [TypeId]: TypeId
	readonly rules: ReadonlyArray<Rules>
	readonly options: AbilityOptions<Subjects, Aliases>
	readonly _Subjects?: (_: never) => Subjects
	readonly _Rules?: (_: never) => Rules
	readonly _Aliases?: (_: never) => Aliases
}

type ElementOf<A> = A extends ReadonlyArray<infer B> ? B : A
type SubjectFor<Subjects extends SubjectMap, Name> = Name extends AnySubject
	? SubjectUnion<Subjects>
	: Name extends SubjectName<Subjects>
		? Subjects[Name]
		: never
type PreviousAliasDepth = [never, 0, 1, 2, 3, 4, 5]

/**
 * Gives an action together with all the actions that its aliases cover. An
 * alias is a second name for an action. The type goes down only five levels,
 * so type checking stays fast.
 *
 * @since 0.1.0
 * @category Models
 */
export type ExpandedAction<
	Action extends string,
	Aliases extends ActionAliases,
	Depth extends number = 5,
> =
	| Action
	| ([Depth] extends [0]
			? never
			: Action extends keyof Aliases & string
				? ExpandedAction<
						ElementOf<Aliases[Action]> & string,
						Aliases,
						PreviousAliasDepth[Depth]
					>
				: never)

/**
 * @since 0.1.0
 * @category Models
 */
export interface Builder<Subjects extends SubjectMap> {
	readonly allow: <
		const Action extends SingleOrReadonlyArray<string>,
		const Name extends SingleOrReadonlyArray<RuleSubject<Subjects>>,
		const Fields extends FieldOf<
			SubjectFor<Subjects, ElementOf<Name>> & object
		> = FieldOf<SubjectFor<Subjects, ElementOf<Name>> & object>,
	>(
		action: Action,
		subject: Name,
		options?: RuleOptions<
			SubjectFor<Subjects, ElementOf<Name>> & object,
			Fields
		>,
	) => Rule<
		"Allow",
		ElementOf<Action> & string,
		ElementOf<Name> & string,
		SubjectFor<Subjects, ElementOf<Name>> & object,
		Fields
	>

	readonly deny: <
		const Action extends SingleOrReadonlyArray<string>,
		const Name extends SingleOrReadonlyArray<RuleSubject<Subjects>>,
		const Fields extends FieldOf<
			SubjectFor<Subjects, ElementOf<Name>> & object
		> = FieldOf<SubjectFor<Subjects, ElementOf<Name>> & object>,
	>(
		action: Action,
		subject: Name,
		options?: RuleOptions<
			SubjectFor<Subjects, ElementOf<Name>> & object,
			Fields
		>,
	) => Rule<
		"Deny",
		ElementOf<Action> & string,
		ElementOf<Name> & string,
		SubjectFor<Subjects, ElementOf<Name>> & object,
		Fields
	>
}

/**
 * @since 0.1.0
 * @category Models
 */
export interface RawRule<
	Action extends string = string,
	Name extends string = string,
	Fields extends string = string,
	Conditions = unknown,
> {
	readonly action: SingleOrReadonlyArray<Action>
	readonly subject: SingleOrReadonlyArray<Name>
	readonly fields?: SingleOrReadonlyArray<Fields>
	readonly conditions?: Conditions
	readonly inverted?: boolean
	readonly reason?: string
}

type RuleAction<Rules> =
	Rules extends Rule<
		infer _Kind,
		infer Action,
		infer _Name,
		infer _Subject,
		infer _Fields
	>
		? Action
		: never
type RuleSubjectName<Rules> =
	Rules extends Rule<
		infer _Kind,
		infer _Action,
		infer Name,
		infer _Subject,
		infer _Fields
	>
		? Name
		: never
type RuleFields<Rules> =
	Rules extends Rule<
		infer _Kind,
		infer _Action,
		infer _Name,
		infer _Subject,
		infer Fields
	>
		? Fields
		: never

type ActionMatches<
	Rule,
	Action extends string,
	Aliases extends ActionAliases,
> = Rule extends AnyRule
	? Action extends ExpandedAction<RuleAction<Rule> & string, Aliases>
		? Rule
		: AnyAction extends RuleAction<Rule>
			? Rule
			: never
	: never
type SubjectMatches<Rule, Name extends string> = Rule extends AnyRule
	? Name extends RuleSubjectName<Rule>
		? Rule
		: AnySubject extends RuleSubjectName<Rule>
			? Rule
			: never
	: never
type RulesMatching<
	Rules,
	Action extends string,
	Name extends string,
	Aliases extends ActionAliases,
> = SubjectMatches<ActionMatches<Rules, Action, Aliases>, Name>

type RuleAllowedActions<
	Rule,
	Aliases extends ActionAliases,
> = Rule extends AnyRule
	? AnyAction extends RuleAction<Rule>
		? string
		: ExpandedAction<RuleAction<Rule> & string, Aliases>
	: never
type RuleAllowedSubjects<Subjects extends SubjectMap, Rule> =
	AnySubject extends RuleSubjectName<Rule>
		? SubjectName<Subjects>
		: Extract<RuleSubjectName<Rule>, SubjectName<Subjects>>
type AllowedActions<Rules, Aliases extends ActionAliases> = RuleAllowedActions<
	Rules,
	Aliases
>
type AllowedSubjects<Subjects extends SubjectMap, Rules> = RuleAllowedSubjects<
	Subjects,
	Rules
>
type FieldFor<
	Subjects extends SubjectMap,
	Rules,
	Aliases extends ActionAliases,
	Action extends string,
	Name extends SubjectName<Subjects>,
> =
	RuleFields<RulesMatching<Rules, Action, Name, Aliases>> extends infer Fields
		? [Fields] extends [never]
			? never
			: string extends Fields & string
				? FieldOf<Subjects[Name]>
				: Extract<Fields, FieldPattern> extends never
					? Extract<Fields & string, FieldOf<Subjects[Name]>>
					: FieldOf<Subjects[Name]>
		: never

type ExplicitRuleCheckRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases,
	Rule extends AnyRule,
> =
	RuleAllowedActions<Rule, Aliases> extends infer Action
		? Action extends string
			? RuleAllowedSubjects<Subjects, Rule> extends infer Name
				? Name extends SubjectName<Subjects>
					? {
							readonly action: Action
							readonly subject: Name
							readonly value?:
								Subjects[Name] | TypedSubject<Name, Subjects[Name]>
							readonly field?: FieldFor<Subjects, Rules, Aliases, Action, Name>
						}
					: never
				: never
			: never
		: never

type ExplicitCheckRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases,
> = Rules extends AnyRule
	? ExplicitRuleCheckRequest<Subjects, Rules, Aliases, Rules>
	: never

type TypedSubjectRuleCheckRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases,
	Rule extends AnyRule,
> =
	RuleAllowedActions<Rule, Aliases> extends infer Action
		? Action extends string
			? RuleAllowedSubjects<Subjects, Rule> extends infer Name
				? Name extends SubjectName<Subjects>
					? {
							readonly action: Action
							readonly subject?: never
							readonly value: TypedSubject<Name, Subjects[Name]>
							readonly field?: FieldFor<Subjects, Rules, Aliases, Action, Name>
						}
					: never
				: never
			: never
		: never

type TypedSubjectCheckRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases,
> = Rules extends AnyRule
	? TypedSubjectRuleCheckRequest<Subjects, Rules, Aliases, Rules>
	: never

type DetectedSubjectRuleCheckRequest<
	Subjects extends SubjectMap,
	Aliases extends ActionAliases,
	Rule extends AnyRule,
> =
	RuleAllowedActions<Rule, Aliases> extends infer Action
		? Action extends string
			? RuleAllowedSubjects<Subjects, Rule> extends infer Name
				? Name extends SubjectName<Subjects>
					? {
							readonly action: Action
							readonly subject?: never
							readonly value: Subjects[Name]
							readonly field?: string
						}
					: never
				: never
			: never
		: never

type DetectedSubjectCheckRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases,
> = Rules extends AnyRule
	? DetectedSubjectRuleCheckRequest<Subjects, Aliases, Rules>
	: never

/**
 * @since 0.1.0
 * @category Models
 */
export type CheckRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases = {},
> =
	| ExplicitCheckRequest<Subjects, Rules, Aliases>
	| TypedSubjectCheckRequest<Subjects, Rules, Aliases>
	| DetectedSubjectCheckRequest<Subjects, Rules, Aliases>

/**
 * @since 0.1.0
 * @category Models
 */
export type RuleQueryRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases = {},
> = CheckRequest<Subjects, Rules, Aliases>

type ExplicitSubjectQueryRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
> =
	AllowedSubjects<Subjects, Rules> extends infer Name
		? Name extends SubjectName<Subjects>
			? {
					readonly subject: Name
					readonly value?: Subjects[Name] | TypedSubject<Name, Subjects[Name]>
				}
			: never
		: never

type TypedSubjectQueryRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
> =
	AllowedSubjects<Subjects, Rules> extends infer Name
		? Name extends SubjectName<Subjects>
			? {
					readonly subject?: never
					readonly value: TypedSubject<Name, Subjects[Name]>
				}
			: never
		: never

/**
 * @since 0.1.0
 * @category Models
 */
export type SubjectQueryRequest<
	Subjects extends SubjectMap,
	Rules extends AnyRule,
> =
	| ExplicitSubjectQueryRequest<Subjects, Rules>
	| TypedSubjectQueryRequest<Subjects, Rules>
	| {
			readonly subject?: never
			readonly value: SubjectUnion<Subjects>
	  }

type RequestAction<Request> = Request extends { readonly action: infer Action }
	? Action & string
	: string
type RequestSubject<Request> = Request extends { readonly subject: infer Name }
	? Name & string
	: Request extends { readonly value: TypedSubject<infer Name, object> }
		? Name & string
		: string
type MatchingRules<
	Rules,
	Request,
	Aliases extends ActionAliases,
> = RulesMatching<
	Rules,
	RequestAction<Request>,
	RequestSubject<Request>,
	Aliases
>

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
 * @since 0.1.0
 * @category Errors
 */
export const AliasError = internal.AliasError

/**
 * @since 0.1.0
 * @category Errors
 */
export type AliasError = internal.AliasError

/**
 * @since 0.1.0
 * @category Errors
 */
export const QueryGenerationError = internal.QueryGenerationError

/**
 * @since 0.1.0
 * @category Errors
 */
export type QueryGenerationError = internal.QueryGenerationError

/**
 * Makes a function that gives all the actions that an action covers, using a
 * map of aliases.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const createAliasResolver: <const Aliases extends ActionAliases>(
	aliases: Aliases,
) => ActionResolver = internal.createAliasResolver

/**
 * Makes an Ability from a generator function that gives rules. The Ability
 * does not change after that.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const define: <Subjects extends SubjectMap>() => <
	Eff extends AnyRule,
	A,
	const Aliases extends ActionAliases = {},
>(
	body: (builder: Builder<Subjects>) => Generator<Eff, A, unknown>,
	options?: AbilityOptions<Subjects, Aliases>,
) => Ability<Subjects, Eff, Aliases> = internal.define

/**
 * Makes an Ability from a list of rules.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const make: <
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	const Aliases extends ActionAliases = {},
>(
	rules: Iterable<Rules>,
	options?: AbilityOptions<Subjects, Aliases>,
) => Ability<Subjects, Rules, Aliases> = internal.make

/**
 * Makes an Ability from raw rules. Raw rules are plain JSON data.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const fromRawRules: <
	Subjects extends SubjectMap,
	const Aliases extends ActionAliases = {},
>(
	rules: Iterable<
		RawRule<string, RuleSubject<Subjects>, string, MongoCondition<any>>
	>,
	options?: AbilityOptions<Subjects, Aliases>,
) => Effect.Effect<
	Ability<Subjects, AnyRule, Aliases>,
	AliasError | RawRuleError
> = internal.fromRawRules

/**
 * Makes a new Ability from raw rules. The new Ability keeps the options of the
 * old one.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const update: {
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
	>(
		rules: Iterable<
			RawRule<string, RuleSubject<Subjects>, string, MongoCondition<any>>
		>,
	): (
		self: Ability<Subjects, Rules, Aliases>,
	) => Effect.Effect<
		Ability<Subjects, AnyRule, Aliases>,
		AliasError | RawRuleError
	>
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
	>(
		self: Ability<Subjects, Rules, Aliases>,
		rules: Iterable<
			RawRule<string, RuleSubject<Subjects>, string, MongoCondition<any>>
		>,
	): Effect.Effect<
		Ability<Subjects, AnyRule, Aliases>,
		AliasError | RawRuleError
	>
} = internal.update

/**
 * Puts a subject name on a value. It is pure and does not change the value.
 *
 * @since 0.1.0
 * @category Constructors
 */
export const subject: <const Name extends string, Value extends object>(
	name: Name,
	value: Value,
) => TypedSubject<Name, Value> = internal.subject

/**
 * Tests if a value is an Ability.
 *
 * @since 0.1.0
 * @category Guards
 */
export const isAbility: (
	value: unknown,
) => value is Ability<SubjectMap, AnyRule, ActionAliases> = internal.isAbility

/**
 * Tests if a value is a rule.
 *
 * @since 0.1.0
 * @category Guards
 */
export const isRule: (value: unknown) => value is AnyRule = internal.isRule

/**
 * Tests if a value has a subject name put on it by {@link subject}.
 *
 * @since 0.1.0
 * @category Guards
 */
export const isSubject: (
	value: unknown,
) => value is TypedSubject<string, object> = internal.isSubject

/**
 * Takes the value back out of a value made by {@link subject}.
 *
 * @since 0.1.0
 * @category Accessors
 */
export const unwrapSubject: <Value>(
	value: Value,
) => Value extends TypedSubject<infer _Name, infer Subject> ? Subject : Value =
	internal.unwrapSubject as never

/**
 * Gets the subject name of a value, in the way that the Ability is set up to
 * do it.
 *
 * @since 0.1.0
 * @category Accessors
 */
export const detectSubjectType: <
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases,
>(
	self: Ability<Subjects, Rules, Aliases>,
	value: object | TypedSubject<SubjectName<Subjects>, SubjectUnion<Subjects>>,
) => Effect.Effect<SubjectName<Subjects>, SubjectDetectionError> =
	internal.detectSubjectType

/**
 * Changes an Ability into raw rules. Raw rules are plain JSON data.
 *
 * @since 0.1.0
 * @category Conversions
 */
export const toRawRules: <
	Subjects extends SubjectMap,
	Rules extends AnyRule,
	Aliases extends ActionAliases,
>(
	self: Ability<Subjects, Rules, Aliases>,
) => Effect.Effect<ReadonlyArray<RawRule>> = internal.toRawRules

/**
 * Gives the rules that may apply to a request, before the field and condition
 * tests.
 *
 * @since 0.1.0
 * @category Accessors
 */
export const possibleRulesFor: {
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends RuleQueryRequest<Subjects, Rules, Aliases>,
	>(
		request: Request,
	): (
		self: Ability<Subjects, Rules, Aliases>,
	) => Effect.Effect<
		ReadonlyArray<MatchingRules<Rules, Request, Aliases>>,
		SubjectDetectionError
	>
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends RuleQueryRequest<Subjects, Rules, Aliases>,
	>(
		self: Ability<Subjects, Rules, Aliases>,
		request: Request,
	): Effect.Effect<
		ReadonlyArray<MatchingRules<Rules, Request, Aliases>>,
		SubjectDetectionError
	>
} = internal.possibleRulesFor

/**
 * Gives the rules that may apply to a request, after the field test and before
 * the condition test.
 *
 * @since 0.1.0
 * @category Accessors
 */
export const rulesFor: {
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends RuleQueryRequest<Subjects, Rules, Aliases>,
	>(
		request: Request,
	): (
		self: Ability<Subjects, Rules, Aliases>,
	) => Effect.Effect<
		ReadonlyArray<MatchingRules<Rules, Request, Aliases>>,
		SubjectDetectionError
	>
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends RuleQueryRequest<Subjects, Rules, Aliases>,
	>(
		self: Ability<Subjects, Rules, Aliases>,
		request: Request,
	): Effect.Effect<
		ReadonlyArray<MatchingRules<Rules, Request, Aliases>>,
		SubjectDetectionError
	>
} = internal.rulesFor

/**
 * Gives the rule that wins for a request, or `undefined` when no rule matches.
 *
 * @since 0.1.0
 * @category Accessors
 */
export const relevantRuleFor: {
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends RuleQueryRequest<Subjects, Rules, Aliases>,
	>(
		request: Request,
	): (
		self: Ability<Subjects, Rules, Aliases>,
	) => Effect.Effect<
		MatchingRules<Rules, Request, Aliases> | undefined,
		ConditionError | SubjectDetectionError
	>
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends RuleQueryRequest<Subjects, Rules, Aliases>,
	>(
		self: Ability<Subjects, Rules, Aliases>,
		request: Request,
	): Effect.Effect<
		MatchingRules<Rules, Request, Aliases> | undefined,
		ConditionError | SubjectDetectionError
	>
} = internal.relevantRuleFor

/**
 * Gives the actions that have rules for a subject.
 *
 * @since 0.1.0
 * @category Accessors
 */
export const actionsFor: {
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends SubjectQueryRequest<Subjects, Rules>,
	>(
		request: Request,
	): (
		self: Ability<Subjects, Rules, Aliases>,
	) => Effect.Effect<
		ReadonlyArray<AllowedActions<Rules, Aliases>>,
		SubjectDetectionError
	>
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends SubjectQueryRequest<Subjects, Rules>,
	>(
		self: Ability<Subjects, Rules, Aliases>,
		request: Request,
	): Effect.Effect<
		ReadonlyArray<AllowedActions<Rules, Aliases>>,
		SubjectDetectionError
	>
} = internal.actionsFor

/**
 * Checks a request. It fails with `AuthorizationError` when the answer is no.
 *
 * @since 0.1.0
 * @category Combinators
 */
export const check: {
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends CheckRequest<Subjects, Rules, Aliases>,
	>(
		request: Request,
	): (
		self: Ability<Subjects, Rules, Aliases>,
	) => Effect.Effect<
		void,
		AuthorizationError | ConditionError | SubjectDetectionError
	>
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends CheckRequest<Subjects, Rules, Aliases>,
	>(
		self: Ability<Subjects, Rules, Aliases>,
		request: Request,
	): Effect.Effect<
		void,
		AuthorizationError | ConditionError | SubjectDetectionError
	>
} = internal.check

/**
 * Gives the fields that the rules let a request use.
 *
 * @since 0.1.0
 * @category Combinators
 */
export const permittedFields: {
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends CheckRequest<Subjects, Rules, Aliases>,
	>(
		request: Request,
		options: PermittedFieldsOptions<Rules>,
	): (
		self: Ability<Subjects, Rules, Aliases>,
	) => Effect.Effect<
		ReadonlyArray<string>,
		ConditionError | SubjectDetectionError
	>
	<
		Subjects extends SubjectMap,
		Rules extends AnyRule,
		Aliases extends ActionAliases,
		const Request extends CheckRequest<Subjects, Rules, Aliases>,
	>(
		self: Ability<Subjects, Rules, Aliases>,
		request: Request,
		options: PermittedFieldsOptions<Rules>,
	): Effect.Effect<
		ReadonlyArray<string>,
		ConditionError | SubjectDetectionError
	>
} = internal.permittedFields
