import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	failingFetch,
	fakeFetch,
	forbiddenFetch,
	LITELLM_FIXTURE,
	LITELLM_URL,
	usageRow,
	useTempCacheDirs,
} from "./pricing.fixtures.js";
import { price } from "./pricing.js";
import { DEFAULT_MAX_CACHE_AGE_MS } from "./pricing-table.js";

const newCacheDir = useTempCacheDirs();

const M = 1_000_000;

/** One priceable row: 1M input tokens on Sonnet 4.5 (3 USD with the fixture, 0 when unpriced). */
const sonnetRow = () => usageRow({ tokens: { input: M } });

/** The single file the price cache is stored in. */
async function cacheFile(cacheDir: string): Promise<string> {
	const files = await readdir(cacheDir);
	expect(files).toHaveLength(1);
	return join(cacheDir, files[0] as string);
}

describe("price table: fetch once, then stay offline", () => {
	it("fetches the LiteLLM table when there is no cache, prices from it and caches it", async () => {
		const cacheDir = await newCacheDir();
		const fetch = fakeFetch(LITELLM_FIXTURE);

		const [row] = await price([sonnetRow()], { cacheDir, fetch });

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(String(url)).toBe(LITELLM_URL);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
		// Exactly one file, no temp leftovers from the atomic write.
		expect(await readdir(cacheDir)).toHaveLength(1);
	});

	it("makes ZERO network calls once a valid cache exists", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });

		const offline = forbiddenFetch();
		const [row] = await price([sonnetRow(), sonnetRow()], {
			cacheDir,
			fetch: offline,
		});

		expect(offline).not.toHaveBeenCalled();
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("a cache within the max age is used immediately, with no fetch attempt", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		// Comfortably inside DEFAULT_MAX_CACHE_AGE_MS (24h), not just "freshly written" - proves
		// the fast path survives real age, not only a brand-new cache.
		const anHourAgo = new Date(Date.now() - 3600 * 1000);
		await utimes(file, anHourAgo, anHourAgo);

		const offline = forbiddenFetch();
		const [row] = await price([sonnetRow()], { cacheDir, fetch: offline });

		expect(offline).not.toHaveBeenCalled();
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	/** Older than DEFAULT_MAX_CACHE_AGE_MS by a comfortable margin, not just past it. */
	function ageCacheFile(file: string): Promise<void> {
		const wellPastMaxAge = new Date(
			Date.now() - DEFAULT_MAX_CACHE_AGE_MS - 3600 * 1000,
		);
		return utimes(file, wellPastMaxAge, wellPastMaxAge);
	}

	// myusage-4xu.115: backs the doc-comment-pinning test below, plus the attack-scenario tests
	// that follow it. A FORWARD, string-and-comment-aware token scan - the same idiom
	// scripts/fixtures-guard.ts's stripComments already uses in this repo's own `yarn lint` gate
	// - not a backward lastIndexOf search. Two independent review rounds on the backward version
	// of this helper each found a real false-pass the previous round's fix didn't anticipate:
	// round 1, a plain `/* */` block (not JSDoc) directly above a member was silently accepted as
	// if it were that member's own doc comment; round 2, that same false-pass survived under a
	// new trigger (a plain block whose own body happens to contain a literal "/*"), and a separate
	// false FAILURE appeared too, on a legitimate JSDoc whose own prose contains the literal
	// substring "/**" (this very file's normalizeDocComment doc comment, below, does exactly
	// that). A new gap in each of two consecutive rounds is itself evidence that a backward,
	// positional scan is the wrong shape of fix, not just an unlucky pair of misses.
	//
	// Tokenizing forward first, then walking the resulting TOKEN LIST backward from the member,
	// removes the "which comment does this belong to" ambiguity by construction: a `/*`, `*/`, or
	// `//` that starts inside a string or another comment's own text is already consumed into
	// that other token by the time any backward walk begins, so it can never be mistaken for a
	// real delimiter - unlike a raw string search, which has no way to tell "this looks like a
	// delimiter" apart from "this IS a delimiter" without re-deriving the very boundaries it's
	// trying to find.
	type Token =
		| { kind: "code"; text: string }
		| { kind: "string"; text: string }
		| { kind: "lineComment"; text: string }
		| { kind: "blockComment"; text: string; jsdoc: boolean };

	// Mirrors scripts/fixtures-guard.ts's STRING_OR_COMMENT for the string/template and
	// line-comment branches (see that file's own comment for why trying the string branch first,
	// at every position, keeps a "//" or "/*" inside an already-open string from ever reaching
	// the comment branches). The block-comment branch just encodes the real ECMAScript rule for
	// comments - they never nest - as a lazy match: `[\s\S]*?\*\/` always stops at the FIRST
	// `*/` after the opening `/*`, whatever the text in between looks like, so a `/*` embedded in
	// a plain block comment's own body is just more of that comment's text, never a second,
	// separate one.
	//
	// Known, accepted gap (the same one scripts/fixtures-guard.ts's own STRING_OR_COMMENT
	// already carries, undocumented there): a regex LITERAL is not itself tokenized as an opaque
	// unit, only strings/templates and comments are, so its pattern text is scanned the same as
	// any other code. Two known fabrication shapes fall out of that, not just a misread quote or
	// backtick: (1) block-comment fabrication - an unescaped "/*" inside a regex CHARACTER CLASS
	// (e.g. `/[/*]/`) reads as a real block-comment opener, fabricating a spurious comment token
	// where none exists in the source; (2) JSDoc fabrication - `/[/**]/` specifically fabricates a
	// spurious JSDoc-shaped token the same way, one docCommentBefore would silently accept as a
	// real doc comment if it happened to land directly before a member. A quote or backtick
	// character inside a regex literal's pattern (in a character class, say) can likewise be
	// misread as a real string delimiter. That misread cuts both ways, not just toward
	// fabricating comment tokens: a quote or backtick inside a regex literal can just as easily
	// fabricate a spurious STRING token that then SWALLOWS a real declaration sitting inside it,
	// silently REDUCING the count of code-token matches for a memberSignature that genuinely
	// appears more than once elsewhere in the file - the same silent-wrong-pin failure class as
	// the round-3 critical above (docCommentBefore picking the wrong one of several matches
	// without knowing it), just reached through this regex gap instead of through the old
	// first-match-wins `findIndex` logic. Confirmed by hand: running this file's own tokenize
	// against this file's own text - not required by anything below, and deliberately not
	// attempted - mis-tokenizes starting at this very regex literal's own `[^"\\]`. Not
	// hypothetical: src/pricing-table.ts DOES already contain a regex literal today (`/\s+/g`,
	// around line 214) - harmless there, since its pattern has no `/*`-shaped sequence and no
	// quote or backtick to misread, but its mere presence means this gap is a live scope call,
	// not a "no regex literals exist" safety margin. Accepted as-is for this test-file-only
	// helper - parsing src/pricing-table.ts's actual member declarations, not arbitrary source -
	// with no fixture below feeding a regex literal of either fabrication shape through
	// docCommentBefore, and no follow-up bead: the risk shape is documented for whoever touches
	// this next.
	//
	// Second, separate known gap: nested template literals. TOKEN's string/template branch
	// matches a backtick-delimited literal as one opaque unit up to its next unescaped backtick,
	// with no awareness of `${...}` interpolation - so a template literal that itself contains a
	// NESTED template inside its interpolation (e.g. `` `a ${ `inner` } b` ``) mis-tokenizes: the
	// inner literal's own opening backtick reads as the OUTER template's closing backtick,
	// cutting the real token short and scanning the rest of the nested expression as ordinary
	// code instead. Distinct from the regex-literal gap above - a different token type, a
	// different shape of mis-tokenization - and low risk in practice for two reasons: (a)
	// src/pricing-table.ts has zero nested-backtick templates today, so nothing docCommentBefore
	// actually parses can trigger it; and (b) a synthetic fixture built to exercise this shape
	// tends to be unusual or syntactically borderline enough that `yarn typecheck` would likely
	// flag related breakage in real code before this test-file-only helper ever ran against it.
	// Accepted as-is for the same reason as the regex-literal gap - this is a helper for pinning
	// one doc comment in one test file, not a production parser - with no fixture below feeding a
	// nested template through docCommentBefore, and no follow-up bead.
	const TOKEN =
		/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)/g;

	/** Tokenizes `source` forward into an ordered list of strings, `//` line comments, `/* *‍/`
	 * block comments (JSDoc or plain - see the `jsdoc` field below), and the code text between
	 * them. Comments are kept as their own typed tokens here, not discarded the way
	 * scripts/fixtures-guard.ts's stripComments discards them: docCommentBefore below needs to
	 * inspect the one comment token immediately before a given member, not just remove every
	 * comment from the text. */
	function tokenize(source: string): Token[] {
		const tokens: Token[] = [];
		let cursor = 0;
		for (const match of source.matchAll(TOKEN)) {
			// TOKEN's three groups are mutually exclusive - exactly one is filled per real match -
			// and `match.index` is typed optional only because RegExpMatchArray's interface is
			// shared with call shapes that can lack one; matchAll always supplies it for a genuine
			// match. Same reasoning this repo's FROM_SPECIFIER/NEW_URL_LITERAL casts in
			// scripts/fixtures-guard.ts already document for their own capture groups.
			const index = match.index as number;
			if (index > cursor) {
				tokens.push({ kind: "code", text: source.slice(cursor, index) });
			}
			const [whole, stringLiteral, lineComment, blockComment] = match;
			if (stringLiteral !== undefined) {
				tokens.push({ kind: "string", text: stringLiteral });
			} else if (lineComment !== undefined) {
				tokens.push({ kind: "lineComment", text: lineComment });
			} else {
				const text = blockComment as string;
				// "/**/" (4 characters) is a plain EMPTY comment, not JSDoc, even though its
				// first three characters happen to spell "/**": its trailing "*" IS the
				// comment's own closing "*/", not a second star belonging to a JSDoc opening.
				// Every other "/**"-prefixed comment - including the 5-character empty JSDoc
				// "/***/" - is JSDoc by the same convention every tool in this ecosystem
				// (TypeScript, ESLint, ...) already applies.
				tokens.push({
					kind: "blockComment",
					text,
					jsdoc: text.startsWith("/**") && text !== "/**/",
				});
			}
			cursor = index + whole.length;
		}
		if (cursor < source.length) {
			tokens.push({ kind: "code", text: source.slice(cursor) });
		}
		return tokens;
	}

	/** Finds the JSDoc comment immediately preceding `memberSignature`'s own declaration in
	 * `source`, or throws - see the header comment above for why this walks the token list from
	 * `tokenize`, not the raw string. Only a "code" token can hold a real declaration (a string or
	 * comment merely mentioning the same text - a glob literal, a stray prose reference - is not
	 * one); and the token immediately before it must be a JSDoc block comment with nothing but
	 * whitespace in between. Real code in that gap, another comment, or a string all mean
	 * whatever JSDoc exists earlier in the file is not genuinely this member's own - this fails
	 * loudly in every one of those cases rather than silently pinning against the wrong text.
	 *
	 * `memberSignature` must identify exactly one declaration. A live reproduction (myusage-4xu.115
	 * review round 3) drifted `LoadOptions.maxCacheAgeMs`'s doc comment in src/pricing-table.ts
	 * away from its promised wording, then added a second, unrelated interface earlier in that
	 * same file with a copy-pasted `maxCacheAgeMs?: number;` field carrying the ORIGINAL, correct
	 * doc comment: `yarn vitest run`, `yarn lint`, and `yarn typecheck` all stayed green, because
	 * the prior implementation used `Array.prototype.findIndex` - it took the FIRST code token
	 * containing `memberSignature` and never checked whether a second one existed, so it silently
	 * pinned against the decoy's doc comment instead of the real one. Counting every match across
	 * every code token - not just finding the first - and throwing unless there is EXACTLY one
	 * closes that route: an ambiguous signature is a loud, named failure, not a coin flip over
	 * which declaration's doc comment comes back. */
	function docCommentBefore(source: string, memberSignature: string): string {
		const tokens = tokenize(source);
		const matches: Array<{ tokenIndex: number; withinTokenIndex: number }> = [];
		tokens.forEach((token, tokenIndex) => {
			if (token.kind !== "code") {
				return;
			}
			let searchFrom = 0;
			for (;;) {
				const withinTokenIndex = token.text.indexOf(
					memberSignature,
					searchFrom,
				);
				if (withinTokenIndex === -1) {
					break;
				}
				matches.push({ tokenIndex, withinTokenIndex });
				searchFrom = withinTokenIndex + 1;
			}
		});

		if (matches.length === 0) {
			throw new Error(
				`docCommentBefore: ${memberSignature} not found in source`,
			);
		}
		if (matches.length > 1) {
			throw new Error(
				`docCommentBefore: AmbiguousMemberSignature - ${memberSignature} matched ${matches.length} times in source; a memberSignature must uniquely identify one declaration, or docCommentBefore cannot know which doc comment is genuinely its own`,
			);
		}
		const [{ tokenIndex: memberTokenIndex, withinTokenIndex }] = matches as [
			{ tokenIndex: number; withinTokenIndex: number },
		];
		const memberToken = tokens[memberTokenIndex] as Extract<
			Token,
			{ kind: "code" }
		>;

		// Anything other than whitespace between wherever the previous token ended and the
		// member itself means this member isn't documented right here - whether that's real code
		// sitting in the gap, or (see the `previous` checks below) another comment or a string.
		const immediatePrefix = memberToken.text.slice(0, withinTokenIndex);
		if (immediatePrefix.trim() !== "") {
			throw new Error(
				`docCommentBefore: unexpected content between the doc comment and ${memberSignature}: ${JSON.stringify(immediatePrefix)}`,
			);
		}

		const previous = tokens[memberTokenIndex - 1];
		if (previous === undefined || previous.kind !== "blockComment") {
			throw new Error(
				`docCommentBefore: no doc comment found directly before ${memberSignature}`,
			);
		}
		if (!previous.jsdoc) {
			throw new Error(
				`docCommentBefore: the comment directly before ${memberSignature} is not a JSDoc block`,
			);
		}
		// tokenize already isolated exactly this comment's own text, delimiters included -
		// stripping the outer "/**"/"*/" here, instead of leaving it to normalizeDocComment,
		// means that function no longer needs to know or guess anything about comment syntax.
		return previous.text.slice(
			"/**".length,
			previous.text.length - "*/".length,
		);
	}

	/** Strips each line's leading (possibly tab-indented) `* ` continuation prefix, then
	 * collapses all remaining whitespace - including the newlines, and any CRLF carriage
	 * returns, docCommentBefore's raw return value still carries - to single spaces. Only the
	 * words themselves are compared below, never their exact line layout or line-ending style, so
	 * a harmless re-wrap of the same sentence does not fail the test. Does not strip a leading
	 * `/**` itself: docCommentBefore already hands this only the comment's inner body, with both
	 * delimiters already removed by its own tokenizer.
	 */
	function normalizeDocComment(doc: string): string {
		return doc
			.replace(/^[ \t]*\*[ \t]?/gm, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	it("fetches fresh data and rewrites the cache when the refresh succeeds", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);
		const repriced = {
			...LITELLM_FIXTURE,
			"claude-sonnet-4-5": {
				...LITELLM_FIXTURE["claude-sonnet-4-5"],
				input_cost_per_token: 0.000004,
			},
		};
		const fetch = fakeFetch(repriced);
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], { cacheDir, fetch, warn });

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(4, 9);
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
			"claude-sonnet-4-5": { input_cost_per_token: 0.000004 },
		});
		// myusage-4xu.81: a successful refresh must emit zero warnings - a mutation that
		// spuriously warns on success was previously only caught incidentally, by four unrelated
		// pre-existing tests in this file, not this one.
		expect(warn).not.toHaveBeenCalled();
	});

	it("refresh: true against an already-stale cache still makes exactly one fetch, not two (myusage-4xu.81: the manual refresh flag from PR #75 meeting the new auto-refresh-on-stale from PR #76 - both collapse onto the same one-fetch path in loadPriceTable, but nothing in the suite exercised the combination directly. PR #82's own noPriceRefresh: true tests don't reach it either: that flag short-circuits `stale` to false before this combination is ever evaluated)", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);
		const fetch = fakeFetch(LITELLM_FIXTURE);

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			refresh: true,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("honors a realistic positive LoadOptions.maxCacheAgeMs against a real file mtime, beating a cache that's genuinely still within DEFAULT_MAX_CACHE_AGE_MS (myusage-4xu.80: LoadOptions.maxCacheAgeMs's doc comment documents this override's test-only purpose - pinned by the dedicated doc-comment test below (myusage-4xu.115) against pricing-table.ts's live text, not reproduced here as prose the way this title used to quote it verbatim. That quote drifted out of sync with the doc comment twice with nothing to catch it, since nothing asserted on the string: PR #105 changed the wording, and PR #109 had to fix the stale quote by hand. Existing coverage elsewhere in this repo only ever passes maxCacheAgeMs: -1, a force-stale sentinel that bypasses isCacheStale's real age comparison entirely; nothing exercised a genuine positive threshold shrinking the window below a cache's real, unforced age. Confirmed by mutation: deleting the `?? DEFAULT_MAX_CACHE_AGE_MS` fallback in loadPriceTable fails this test - and also src/pricing-table.test.ts's existing `-1`-sentinel baseline test, since both now compare against the same hardcoded default - but neither test alone would have caught a narrower bug that only mishandled a real positive override)", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		// Well within DEFAULT_MAX_CACHE_AGE_MS (24h) - the default staleness window would not
		// consider this cache stale, so a fetch here can only happen because maxCacheAgeMs
		// shrank the window below this cache's real age.
		const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
		await utimes(file, twoHoursAgo, twoHoursAgo);
		const fetch = fakeFetch(LITELLM_FIXTURE);

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			maxCacheAgeMs: 1000,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("LoadOptions.maxCacheAgeMs's doc comment still promises tests can use it to shrink or force the cache-staleness window (myusage-4xu.115: the test above used to quote this doc comment's own prose in its title, with nothing asserting on that quoted string - a comment-only drift no test or lint guard in this repo could catch. PR #105 changed the doc comment's wording, and PR #109 had to fix the resulting stale quote by hand: the second time this exact title drifted, with yarn test and yarn lint both staying green throughout both times. This test reads pricing-table.ts's real, live text instead of reproducing its prose, so an actual wording change here fails this assertion, by name, instead of drifting silently)", async () => {
		const source = await readFile(
			new URL("./pricing-table.ts", import.meta.url),
			"utf8",
		);
		const doc = docCommentBefore(source, "maxCacheAgeMs?: number;");

		// Normalized: the assertion is about the wording, not the exact line-wrap - a harmless
		// re-wrap of this same sentence must not fail this test (myusage-4xu.115 review flag 4).
		expect(normalizeDocComment(doc)).toContain(
			"tests use it to shrink or force the cache-staleness window",
		);
	});

	// The tests below prove docCommentBefore/tokenize close every attack scenario found across
	// both prior review rounds, plus three more Brice's own triage added. Each is a distinct
	// shape of "which comment does this belong to" ambiguity; see tokenize's own header comment
	// for why a forward token scan closes the whole class rather than one instance of it.

	it('rejects a plain /* */ block directly before a member, even when a real JSDoc sits further back and even when the plain block\'s own body happens to contain an embedded, JSDoc-looking "/**" (review round 1: a backward scan silently accepted a plain block as the target\'s own JSDoc; round 2: the same false-pass survived under a new trigger - a backward lastIndexOf("/*", ...) landing on THIS embedded "/**" instead of the block\'s own real opening, and then passing every later sanity check by coincidence, since the text from there to the real close is still well-formed - confirmed by hand against the pre-tokenizer implementation: it silently returned the embedded fragment\'s own text instead of throwing)', () => {
		const source = `
			/**
			 * the real, far doc comment - must never be reached; something else sits directly above the member
			 */
			/* a plain note, not JSDoc, whose own body happens to contain /** an embedded jsdoc-looking marker */
			plainBlockMember: string;
		`;
		expect(() => docCommentBefore(source, "plainBlockMember: string;")).toThrow(
			/is not a JSDoc block/,
		);
	});

	it('correctly extracts a JSDoc whose own prose contains the literal substrings "/**" and "/*" - the same shape of prose this repo\'s own normalizeDocComment doc comment (above) naturally has, since it explains those very markers (review round 2: a backward scan re-derived a comment\'s boundaries by searching its OWN content for "/*"/"*/"-shaped text, which prose describing comment syntax can trivially confuse; tokenize never re-derives boundaries from content, since it records them once, correctly, while scanning forward - a synthetic fixture here, not this file\'s own text, for the reason given on TOKEN\'s own comment above)', () => {
		const source = `
			/**
			 * A real JSDoc's own opening marker looks like /** while a plain block comment just uses
			 * /* without the second star - this sentence itself contains both, as an example.
			 */
			selfReferentialMember: string;
		`;
		const doc = docCommentBefore(source, "selfReferentialMember: string;");
		expect(normalizeDocComment(doc)).toContain(
			"this sentence itself contains both, as an example",
		);
	});

	it("rejects a member with no preceding comment at all", () => {
		const source = "\nbareMember: string;\n";
		expect(() => docCommentBefore(source, "bareMember: string;")).toThrow(
			/no doc comment found directly before/,
		);
	});

	it('accepts an empty JSDoc ("/***/", the minimal valid JSDoc: opening /** immediately followed by closing */ with nothing between) without misclassifying it as the plain, non-JSDoc empty comment "/**/" one character shorter', () => {
		const source = "/***/\nemptyDocMember: string;\n";
		const doc = docCommentBefore(source, "emptyDocMember: string;");
		expect(normalizeDocComment(doc)).toBe("");
	});

	it('rejects a plain, non-JSDoc empty comment "/**/" (4 characters) directly before a member, the mirror image of the previous test: nothing previously asserted that THIS 4-character case is actually REJECTED, only that the 5-character empty JSDoc "/***/" is accepted (myusage-4xu.115 review flag 2)', () => {
		const source = "/**/\nplainEmptyCommentMember: string;\n";
		expect(() =>
			docCommentBefore(source, "plainEmptyCommentMember: string;"),
		).toThrow(/is not a JSDoc block/);
	});

	it("finds and normalizes a doc comment correctly across CRLF line endings", () => {
		const source =
			"/**\r\n * crlf doc line one\r\n * crlf doc line two\r\n */\r\ncrlfMember: string;\r\n";
		const doc = docCommentBefore(source, "crlfMember: string;");
		expect(normalizeDocComment(doc)).toBe(
			"crlf doc line one crlf doc line two",
		);
	});

	it('rejects a member when a // line comment - even one whose own text contains "*/" - sits between the real JSDoc and the member, rather than reaching past it (Brice\'s review: a "*/" inside an intervening // comment must stay part of that comment\'s own text, never a stray close)', () => {
		const source = `
			/**
			 * the real doc comment - never reached, because a line comment sits between it and the member
			 */
			// see the block comment above this line for why this looks like it should close with */
			blockedMember: string;
		`;
		expect(() => docCommentBefore(source, "blockedMember: string;")).toThrow(
			/no doc comment found directly before/,
		);
	});

	it('is not confused by a glob-shaped string literal (e.g. "src/**/*.ts") appearing earlier in the file - it is tokenized as one opaque unit, so its embedded /** and */-like sequences can never be mistaken for real comment delimiters, and a genuine JSDoc later in the same file is still found correctly (Brice\'s review)', () => {
		const source = `
			export const pattern = "src/**/*.ts";

			/**
			 * the real doc comment for the member below survives a preceding glob-shaped string literal
			 */
			afterGlobMember: string;
		`;
		const doc = docCommentBefore(source, "afterGlobMember: string;");
		expect(normalizeDocComment(doc)).toContain(
			"survives a preceding glob-shaped string literal",
		);
	});

	it("rejects a member when real code - not just whitespace - sits between the doc comment and the member (Brice's review)", () => {
		const source = `
			/**
			 * this doc comment does not belong to codeBetweenMember - real code sits between them
			 */
			const filler = 1; codeBetweenMember: string;
		`;
		expect(() =>
			docCommentBefore(source, "codeBetweenMember: string;"),
		).toThrow(/unexpected content between the doc comment/);
	});

	it("CRITICAL (myusage-4xu.115 review round 3): rejects a memberSignature that matches more than one declaration, instead of silently pinning against whichever one happens to come first - reproduced live against the real src/pricing-table.ts by drifting LoadOptions.maxCacheAgeMs's doc comment and adding a second, unrelated interface earlier in that same file with a copy-pasted `maxCacheAgeMs?: number;` field carrying the ORIGINAL, correct doc comment; `yarn vitest run`, `yarn lint`, and `yarn typecheck` all stayed green under the prior findIndex-based implementation, which took the first match and never checked for a second. This synthetic fixture reproduces the same shape (two declarations, identical member text, each with its own preceding JSDoc, in one source) without touching the real file", () => {
		const source = `
			interface Decoy {
				/**
				 * the decoy's own doc comment - must never be returned, even though its member text is
				 * byte-for-byte identical to the real declaration below
				 */
				duplicatedMember: string;
			}

			interface Real {
				/**
				 * the real doc comment - the one this call actually wants
				 */
				duplicatedMember: string;
			}
		`;
		expect(() => docCommentBefore(source, "duplicatedMember: string;")).toThrow(
			/AmbiguousMemberSignature/,
		);
	});

	it("rejects a memberSignature that matches zero declarations, the mirror image of the ambiguous-match test above: a renamed or reformatted member leaves docCommentBefore with nothing to pin against, and that must fail loudly by name rather than pin against nothing (myusage-4xu.115 round-4 review)", () => {
		const source = `
			/**
			 * a real doc comment, but not for the signature this call asks about
			 */
			unrelatedMember: string;
		`;
		expect(() => docCommentBefore(source, "missingMember: string;")).toThrow(
			/not found in source/,
		);
	});

	it("DEFAULT_MAX_CACHE_AGE_MS is exactly 24 hours, matching its own doc comment (myusage-4xu.80: nothing pinned this upward - every age-based test in this file derives its ages FROM this constant, so widening it to, say, 7 days would leave the whole suite green while making the doc comment factually wrong)", () => {
		expect(DEFAULT_MAX_CACHE_AGE_MS).toBe(24 * 60 * 60 * 1000);
	});

	it("attempts one refresh, then falls back to the stale cache with a single warning when it fails", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);
		const before = await readFile(file, "utf8");
		const fetch = failingFetch();
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], { cacheDir, fetch, warn });

		// The refresh was attempted exactly once (this is what distinguishes "never expires" from
		// "expires and retries once") ...
		expect(fetch).toHaveBeenCalledTimes(1);
		// ... it failed, so the stale cache's own data still prices the row ...
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
		// ... the cache file itself is untouched (the failed fetch never overwrote it) ...
		expect(await readFile(file, "utf8")).toBe(before);
		// ... and exactly one warning was raised about it - not zero (silent staleness) and not
		// more than one.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toMatch(/refresh failed/i);
	});

	it("noPriceRefresh: true serves a real, well-aged stale cache with zero fetch attempts (myusage-4xu.84)", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);

		const offline = forbiddenFetch();
		const warn = vi.fn();
		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch: offline,
			noPriceRefresh: true,
			warn,
		});

		expect(offline).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("noPriceRefresh: true still performs the very first fetch against a completely empty cache (myusage-4xu.87)", async () => {
		// cached === undefined makes the staleness check moot - there is nothing to judge stale
		// yet - so noPriceRefresh's documented scope ("skip the automatic refresh of a stale
		// cache") does not apply on a fresh install; the very first fetch must still happen. A
		// mutation that instead made noPriceRefresh short-circuit straight to an unpriced result
		// whenever there is no cache would survive every other noPriceRefresh test in this file,
		// since all of them seed a cache before setting the flag.
		const cacheDir = await newCacheDir();
		const fetch = fakeFetch(LITELLM_FIXTURE);

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			noPriceRefresh: true,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("noPriceRefresh: true does not block an explicit refresh: true on the same stale cache", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);
		const repriced = {
			...LITELLM_FIXTURE,
			"claude-sonnet-4-5": {
				...LITELLM_FIXTURE["claude-sonnet-4-5"],
				input_cost_per_token: 0.000004,
			},
		};
		const fetch = fakeFetch(repriced);

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			noPriceRefresh: true,
			refresh: true,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.notionalCost).toBeCloseTo(4, 9);
	});

	it("shows a model missing from the cached table as unpriced until a refresh", async () => {
		const cacheDir = await newCacheDir();
		const { "claude-opus-5": _dropped, ...older } = LITELLM_FIXTURE;
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(older) });

		const opus = usageRow({ model: "claude-opus-5", tokens: { input: M } });
		const offline = forbiddenFetch();
		const [before] = await price([opus], { cacheDir, fetch: offline });
		expect(before).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(offline).not.toHaveBeenCalled();

		const [after] = await price([opus], {
			cacheDir,
			fetch: fakeFetch(LITELLM_FIXTURE),
			refresh: true,
		});
		expect(after?.unpriced).toBe(false);
		expect(after?.notionalCost).toBeCloseTo(5, 9);
	});

	it("refresh: true fetches once even with a valid cache and replaces the cache", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const repriced = {
			...LITELLM_FIXTURE,
			"claude-sonnet-4-5": {
				...LITELLM_FIXTURE["claude-sonnet-4-5"],
				input_cost_per_token: 0.000004,
			},
		};
		const fetch = fakeFetch(repriced);

		const [refreshed] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			refresh: true,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(refreshed?.notionalCost).toBeCloseTo(4, 9);

		// ...and the next plain call is served from the replaced cache, offline.
		const [next] = await price([sonnetRow()], {
			cacheDir,
			fetch: forbiddenFetch(),
		});
		expect(next?.notionalCost).toBeCloseTo(4, 9);
	});

	it("fetches the table for rows from a provider without a rule, since the fallback prices them", async () => {
		const fetch = fakeFetch(LITELLM_FIXTURE);
		const [row] = await price(
			[
				usageRow({
					provider: "github-copilot",
					model: "claude-opus-5",
					tokens: { input: M },
				}),
			],
			{ cacheDir: await newCacheDir(), fetch },
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.notionalCost).toBeCloseTo(5, 9);
	});
});

describe("price table: fetch failures", () => {
	const failures: [string, () => typeof fetch][] = [
		[
			"network error",
			() =>
				vi.fn<typeof fetch>(async () =>
					Promise.reject(new TypeError("fetch failed")),
				),
		],
		["HTTP 503", () => fakeFetch("service unavailable", { status: 503 })],
		["not JSON", () => fakeFetch("<html>nope</html>")],
		["JSON array", () => fakeFetch([1, 2, 3])],
		["JSON null", () => fakeFetch("null")],
		["no usable entries", () => fakeFetch({ nothing: { here: true } })],
	];

	it.each(failures)(
		"%s with a cache: falls back to the cached table and keeps it",
		async (_name, makeFetch) => {
			const cacheDir = await newCacheDir();
			await price([sonnetRow()], {
				cacheDir,
				fetch: fakeFetch(LITELLM_FIXTURE),
			});
			const file = await cacheFile(cacheDir);
			const before = await readFile(file, "utf8");
			const warn = vi.fn();

			const [row] = await price([sonnetRow()], {
				cacheDir,
				fetch: makeFetch(),
				refresh: true,
				warn,
			});

			expect(row?.unpriced).toBe(false);
			expect(row?.notionalCost).toBeCloseTo(3, 9);
			expect(await readFile(file, "utf8")).toBe(before);
			expect(await readdir(cacheDir)).toHaveLength(1);
			// One short line saying the refresh failed.
			expect(warn).toHaveBeenCalledTimes(1);
		},
	);

	it.each(failures)(
		"%s with no cache: every row is unpriced, one warning, no throw, nothing cached",
		async (_name, makeFetch) => {
			const cacheDir = await newCacheDir();
			const warn = vi.fn();
			const rows = [
				sonnetRow(),
				usageRow({ provider: "openai", model: "gpt-5", tokens: { output: 5 } }),
			];

			const out = await price(rows, { cacheDir, fetch: makeFetch(), warn });

			expect(out).toHaveLength(2);
			for (const row of out)
				expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
			expect(out[0]?.tokens.input).toBe(M);
			expect(warn).toHaveBeenCalledTimes(1);
			const message = String(warn.mock.calls[0]?.[0]);
			expect(message).not.toContain("\n");
			expect(message.length).toBeLessThan(200);
			expect(message).toMatch(/price table/i);
			expect(await readdir(cacheDir)).toEqual([]);
		},
	);

	it("writes the default warning as one line on stderr", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			await price([sonnetRow()], {
				cacheDir: await newCacheDir(),
				fetch: vi.fn<typeof fetch>(async () =>
					Promise.reject(new TypeError("fetch failed")),
				),
			});
			const lines = write.mock.calls.map((call) => String(call[0]));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^[^\n]+\n$/);
		} finally {
			write.mockRestore();
		}
	});

	it("never throws, even when an option itself blows up", async () => {
		const warn = vi.fn();
		const options = {
			get cacheDir(): string {
				throw new Error("boom");
			},
			fetch: forbiddenFetch(),
			warn,
		};

		const [row] = await price([sonnetRow()], options);

		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("gives up on a hung fetch after the timeout instead of hanging", async () => {
		const hung = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], {
			cacheDir: await newCacheDir(),
			fetch: hung,
			timeoutMs: 25,
			warn,
		});

		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("rejects a valid table over the size cap, whether the size is declared or streamed", async () => {
		const body = JSON.stringify(LITELLM_FIXTURE);
		const cap = 1000;
		expect(body.length).toBeGreaterThan(cap * 4);
		const declared = vi.fn<typeof fetch>(
			async () =>
				new Response(body, {
					headers: { "content-length": String(body.length) },
				}),
		);
		// A stream carries no content-length, so only counting bytes can catch it.
		const streamed = vi.fn<typeof fetch>(async () => {
			const bytes = new TextEncoder().encode(body);
			return new Response(
				new ReadableStream({
					start(controller) {
						for (let i = 0; i < bytes.length; i += 300) {
							controller.enqueue(bytes.slice(i, i + 300));
						}
						controller.close();
					},
				}),
			);
		});

		for (const fetch of [declared, streamed]) {
			const cacheDir = await newCacheDir();
			const warn = vi.fn();
			const [row] = await price([sonnetRow()], {
				cacheDir,
				fetch,
				maxBytes: cap,
				warn,
			});
			expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(await readdir(cacheDir)).toEqual([]);
		}
	});

	it("does not download a body whose declared size is over the cap", async () => {
		let pulled = 0;
		let cancelled = false;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							pulled++;
							controller.enqueue(new Uint8Array(300));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-length": "999999" } },
				),
		);

		await price([sonnetRow()], {
			cacheDir: await newCacheDir(),
			fetch,
			maxBytes: 1000,
			warn: () => {},
		});

		// The stream primes itself once on construction; any further pull means we read it.
		expect(pulled).toBeLessThanOrEqual(1);
		expect(cancelled).toBe(true);
	});

	it("accepts the same table when it fits under the size cap", async () => {
		const [row] = await price([sonnetRow()], {
			cacheDir: await newCacheDir(),
			fetch: fakeFetch(LITELLM_FIXTURE),
			maxBytes: JSON.stringify(LITELLM_FIXTURE).length,
		});
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("treats a cache file over the size cap as absent", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch: vi.fn<typeof fetch>(async () =>
				Promise.reject(new TypeError("fetch failed")),
			),
			maxBytes: 1000,
			warn,
		});

		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("still prices from the network table when the cache cannot be written, with one warning", async () => {
		const cacheDir = await newCacheDir();
		// A file where the cache directory should be makes mkdir fail.
		const blocker = join(cacheDir, "blocker");
		await writeFile(blocker, "not a directory");
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], {
			cacheDir: join(blocker, "nested"),
			fetch: fakeFetch(LITELLM_FIXTURE),
			warn,
		});

		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("price table: untrusted cache and body", () => {
	const corrupt: [string, string][] = [
		["garbage text", "this is not json {{{"],
		["truncated JSON", '{"claude-sonnet-4-5": {"litellm_provider": "anth'],
		["empty file", ""],
		["JSON array", "[]"],
		["object with no usable entries", '{"a": 1, "b": {"c": 2}}'],
	];

	it.each(corrupt)(
		"a corrupt cache (%s) is treated as absent: refetched and repaired",
		async (_name, contents) => {
			const cacheDir = await newCacheDir();
			await price([sonnetRow()], {
				cacheDir,
				fetch: fakeFetch(LITELLM_FIXTURE),
			});
			const file = await cacheFile(cacheDir);
			await writeFile(file, contents);
			const fetch = fakeFetch(LITELLM_FIXTURE);

			const [row] = await price([sonnetRow()], { cacheDir, fetch });

			expect(fetch).toHaveBeenCalledTimes(1);
			expect(row?.unpriced).toBe(false);
			expect(row?.notionalCost).toBeCloseTo(3, 9);
			expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty(
				"claude-sonnet-4-5",
			);
		},
	);

	it("a corrupt cache and a failed fetch means unpriced, not a throw", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		await writeFile(await cacheFile(cacheDir), "garbage");
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch: vi.fn<typeof fetch>(async () =>
				Promise.reject(new TypeError("fetch failed")),
			),
			warn,
		});

		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("ignores malformed entries one by one and still prices the good ones", async () => {
		// Real ids and rates, deliberately corrupted one field at a time.
		const good = LITELLM_FIXTURE["claude-sonnet-4-5"];
		const table = {
			"claude-sonnet-4-5": good,
			// rate as a string (JS would silently coerce it in arithmetic)
			"claude-opus-5": {
				...LITELLM_FIXTURE["claude-opus-5"],
				input_cost_per_token: "0.000005",
			},
			// negative rate
			"gpt-5": { ...LITELLM_FIXTURE["gpt-5"], output_cost_per_token: -0.00001 },
			// null cache-read rate present but invalid
			"gpt-4o-mini": {
				...LITELLM_FIXTURE["gpt-4o-mini"],
				cache_read_input_token_cost: null,
			},
			// cache-write rate as a string, present but invalid (mirrors the cache-read case above)
			"claude-haiku-4-5": {
				...LITELLM_FIXTURE["claude-haiku-4-5"],
				cache_creation_input_token_cost: "0.00000125",
			},
			// missing output rate
			"gpt-5.1": {
				litellm_provider: "openai",
				input_cost_per_token: 0.00000125,
			},
			// invalid reasoning rate
			"gemini/gemini-robotics-er-2-preview": {
				...LITELLM_FIXTURE["gemini/gemini-robotics-er-2-preview"],
				output_cost_per_reasoning_token: "free",
			},
			// not an object at all
			"xai/grok-4": 7,
			"deepseek/deepseek-chat": ["not", "an", "object"],
		};
		const rows = [
			sonnetRow(),
			usageRow({ model: "claude-opus-5", tokens: { input: M } }),
			usageRow({ provider: "openai", model: "gpt-5", tokens: { input: M } }),
			usageRow({
				provider: "openai",
				model: "gpt-4o-mini",
				tokens: { input: M },
			}),
			usageRow({ model: "claude-haiku-4-5", tokens: { input: M } }),
			usageRow({ provider: "openai", model: "gpt-5.1", tokens: { input: M } }),
			usageRow({ provider: "xai", model: "grok-4", tokens: { input: M } }),
			usageRow({
				provider: "deepseek",
				model: "deepseek-chat",
				tokens: { input: M },
			}),
		];

		const out = await price(rows, {
			cacheDir: await newCacheDir(),
			fetch: fakeFetch(table),
			warn: () => {},
		});

		expect(out[0]?.unpriced).toBe(false);
		expect(out[0]?.notionalCost).toBeCloseTo(3, 9);
		for (const row of out.slice(1))
			expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
	});

	it("treats a table whose keys look like prototype properties as plain data", async () => {
		// Built by hand: JSON.stringify would not emit a real "__proto__" key.
		const entry =
			'{"litellm_provider":"anthropic","input_cost_per_token":1,"output_cost_per_token":1}';
		const rest = JSON.stringify(LITELLM_FIXTURE).slice(1, -1);
		const body = `{"__proto__":${entry},"constructor":${entry},${rest}}`;

		const out = await price(
			[
				sonnetRow(),
				usageRow({ model: "constructor", tokens: { input: 1 } }),
				usageRow({ model: "__proto__", tokens: { input: 1 } }),
			],
			{ cacheDir: await newCacheDir(), fetch: fakeFetch(body), warn: () => {} },
		);

		expect(out[0]?.notionalCost).toBeCloseTo(3, 9);
		// Priced only because the table really carries those keys.
		expect(out[1]?.notionalCost).toBeCloseTo(1, 9);
		expect(out[2]?.notionalCost).toBeCloseTo(1, 9);
		// ...and nothing leaked onto Object.prototype.
		expect(({} as Record<string, unknown>).litellm_provider).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("input_cost_per_token");
	});
});

describe("price table: cache location", () => {
	const strayRelative = "relative-xdg-cache-test";
	afterEach(async () => {
		await rm(strayRelative, { recursive: true, force: true });
	});

	it("uses XDG_CACHE_HOME/my-usage when set", async () => {
		const root = await newCacheDir();
		const home = join(root, "home");

		await price([sonnetRow()], {
			env: { XDG_CACHE_HOME: join(root, "xdg") },
			homeDir: home,
			fetch: fakeFetch(LITELLM_FIXTURE),
		});

		expect(await readdir(join(root, "xdg", "my-usage"))).toHaveLength(1);
		expect(existsSync(home)).toBe(false);
	});

	it.each([
		["unset", {}],
		["empty", { XDG_CACHE_HOME: "" }],
		["relative", { XDG_CACHE_HOME: "relative-xdg-cache-test" }],
	])(
		"falls back to ~/.cache/my-usage when XDG_CACHE_HOME is %s",
		async (_name, env) => {
			const root = await newCacheDir();
			const home = join(root, "home");
			await mkdir(home);

			await price([sonnetRow()], {
				env,
				homeDir: home,
				fetch: fakeFetch(LITELLM_FIXTURE),
			});

			expect(await readdir(join(home, ".cache", "my-usage"))).toHaveLength(1);
			expect(existsSync(strayRelative)).toBe(false);
		},
	);
});
