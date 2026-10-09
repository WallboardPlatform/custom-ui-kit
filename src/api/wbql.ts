/**
 * Builds `search` values for the Wallboard API.
 *
 * WBQL is the query language behind every list endpoint's `search` parameter. It
 * is worth never writing by hand, for two reasons.
 *
 * Its operators are Unicode characters — `≠`, `∈`, `∉`, `≥`, `≤` — which are
 * awkward to type and easy to get subtly wrong.
 *
 * And the encoding is genuinely surprising. The backend parser
 * (`SearchStringParser` in wb-backend-core) splits the query on `,` `|` `(` `)`
 * and on the value operators, and only THEN runs `URLDecoder.decode` on the
 * attribute and the value separately. The servlet container has already decoded
 * the query string once by that point. So any character in a VALUE that WBQL
 * treats as structure has to survive one round of decoding — it must be
 * percent-encoded before the normal URL encoding happens, i.e. double-encoded on
 * the wire.
 *
 * Get that wrong and a customer typing a comma into a search box silently
 * changes the meaning of the query rather than searching for a comma. That is
 * the kind of bug that gets found by a customer, not by us.
 *
 * ```ts
 * import { WB, and, contains, equals } from '@wallboard/custom-ui-kit';
 *
 * const search = and(equals('deviceStatus', 'ONLINE'), contains('name', userInput));
 * const page = await client.api.forCustomer(customerId).get(WB.device, {
 *   query: { search, page: 0, size: 50 }
 * });
 * ```
 */

/** Everything WBQL reads as structure, and so must never reach it raw from a value. */
const STRUCTURAL = [
	['%', '%25'], // first: everything below introduces a % of its own
	[',', '%2C'],
	['|', '%7C'],
	['(', '%28'],
	[')', '%29'],
	[':', '%3A'],
	['=', '%3D'],
	['^', '%5E'],
	['>', '%3E'],
	['<', '%3C'],
	['!', '%21'],
	// URLDecoder turns a raw `+` into a space, so a literal plus has to be escaped.
	['+', '%2B'],
	['≠', '%E2%89%A0'], // ≠
	['∉', '%E2%88%89'], // ∉
	['∈', '%E2%88%88'], // ∈
	['≥', '%E2%89%A5'], // ≥
	['≤', '%E2%89%A4'] // ≤
] as const;

/**
 * Escapes a value so the parser reads it as data rather than as query structure.
 * Exported for tests; you should not need it directly.
 */
export function escapeValue(value: string | number | boolean): string {
	let escaped = String(value);
	for (const [character, replacement] of STRUCTURAL) {
		escaped = escaped.split(character).join(replacement);
	}
	return escaped;
}

/** A field name. Nested paths (`content.name`) and JSON paths (`data->$.x`) are fine. */
type Field = string;
type Value = string | number | boolean;

function clause(field: Field, operator: string, value: Value): string {
	return `${field}${operator}${escapeValue(value)}`;
}

/** Substring match for strings, equality for everything else. The everyday one. */
export const contains = (field: Field, value: Value): string => clause(field, ':', value);

/** Exact match, including for strings. Use for ids, enums and booleans. */
export const equals = (field: Field, value: Value): string => clause(field, '=', value);

export const notEquals = (field: Field, value: Value): string => clause(field, '≠', value);

export const notContains = (field: Field, value: Value): string => clause(field, '∉', value);

export const startsWith = (field: Field, value: Value): string => clause(field, '^', value);

export const greaterThan = (field: Field, value: Value): string => clause(field, '>', value);

export const greaterOrEqual = (field: Field, value: Value): string => clause(field, '≥', value);

export const lessThan = (field: Field, value: Value): string => clause(field, '<', value);

export const lessOrEqual = (field: Field, value: Value): string => clause(field, '≤', value);

/** Matches any of the values. */
export const isIn = (field: Field, values: readonly Value[]): string => `${field}∈${values.map(escapeValue).join(',')}`;

export const isNotIn = (field: Field, values: readonly Value[]): string =>
	`${field}!∈${values.map(escapeValue).join(',')}`;

/** Null, or — for a relation — empty. `teamAssignments` is the usual case. */
export const isNull = (field: Field): string => `${field}=NULL`;

export const isNotNull = (field: Field): string => `${field}=!NULL`;

/** A date field against a JavaScript `Date`. Wallboard stores these as epoch milliseconds. */
export const after = (field: Field, date: Date): string => greaterThan(field, date.getTime());

export const before = (field: Field, date: Date): string => lessThan(field, date.getTime());

function combine(operator: ',' | '|', clauses: (string | null | undefined | false)[]): string {
	const parts = clauses.filter((part): part is string => Boolean(part));
	if (parts.length === 0) return '';
	if (parts.length === 1) return parts[0] as string;
	return parts.join(operator);
}

/**
 * All of them. Falsy entries are dropped, so an optional filter can be written
 * inline: `and(equals('a', 1), query && contains('name', query))`.
 */
export const and = (...clauses: (string | null | undefined | false)[]): string => combine(',', clauses);

/**
 * Any of them, wrapped so it composes safely.
 *
 * WBQL binds OR tighter than AND, which is the opposite of most languages, so an
 * un-grouped `or` inside an `and` would not mean what it looks like. The
 * brackets here remove the question.
 */
export function or(...clauses: (string | null | undefined | false)[]): string {
	const combined = combine('|', clauses);
	return combined.includes('|') ? `(${combined})` : combined;
}
