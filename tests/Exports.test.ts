import { assert, describe, it } from "@effect/vitest"
import * as HttpApi from "../src/HttpApi.ts"
import * as Ability from "../src/index.ts"

// The values that each module gives. A change here is a change to the public
// API, so it needs a new major version or a new minor version.
const expected: Record<string, ReadonlyArray<string>> = {
	Authorizer: ["Forbidden", "Pending", "PolicyUnavailable", "Service", "layer"],
	Condition: [
		"Untranslatable",
		"always",
		"and",
		"andAll",
		"builder",
		"evaluate",
		"evaluateSync",
		"fields",
		"fold",
		"never",
		"not",
		"or",
		"orAll",
		"partial",
		"provideContext",
		"satisfiable",
		"schema",
		"simplify",
	],
	Decision: [
		"Allow",
		"Deny",
		"NotApplicable",
		"isAllow",
		"isDeny",
		"isNotApplicable",
		"match",
		"reason",
	],
	Domain: ["make"],
	Limits: [
		"LimitExceeded",
		"catalogFields",
		"conditionDepth",
		"conditionNodes",
		"fieldPathParts",
		"jsonNodes",
		"patternParts",
		"policyDepth",
		"policyNodes",
		"residualNodes",
		"searchFields",
		"searchSteps",
	],
	Policy: [
		"PolicyError",
		"all",
		"any",
		"builder",
		"ceiling",
		"coverage",
		"decide",
		"decideSync",
		"define",
		"explain",
		"firstOf",
		"permittedFields",
		"provideContext",
		"residual",
		"rule",
		"schema",
	],
	Resource: ["Class", "make"],
}

describe("Exports", () => {
	it("gives the same modules and values as before", () => {
		const modules: Record<string, object> = { ...Ability }
		assert.deepStrictEqual(Object.keys(modules).sort(), Object.keys(expected))
		Object.entries(expected).forEach(([name, values]) => {
			assert.deepStrictEqual(Object.keys(modules[name]!).sort(), values, name)
		})
	})

	it("gives the same values of the HttpApi entry point as before", () => {
		assert.deepStrictEqual(Object.keys(HttpApi).sort(), [
			"GroupRequired",
			"Required",
			"errors",
			"layer",
			"lists",
			"requires",
		])
	})
})
