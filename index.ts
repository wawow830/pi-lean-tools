/**
 * Shorter definitions for pi's built-in tools.
 *
 * pi describes each built-in tool in a paragraph and then repeats most of it on the parameters.
 * This extension rewrites the outgoing request so each tool has a one-line description and each
 * fact sits on the parameter it is about. Schemas, names and behaviour are untouched.
 *
 * A tool is rewritten only when its parameters are exactly the ones listed here, so a pi update
 * that changes a tool's shape falls back to pi's own definition instead of a stale one.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi appends the codemode return shape to each tool description after this marker. */
const CODEMODE_MARKER = "\n\nCodemode: ";

export interface Rewrite {
	/** Top-level parameter names the tool must have, no more and no fewer. */
	params: string[];
	description: string;
	/** Parameter notes by path; a dot steps into an object or into an array's items. */
	notes?: Record<string, string>;
}

export const REWRITES: Record<string, Rewrite> = {
	read: {
		params: ["path", "offset", "limit"],
		description: "Read a text file or image.",
		notes: {
			offset: "1-indexed line to start from",
			limit: "Max lines. Long files are truncated; continue with offset.",
		},
	},
	bash: {
		params: ["command", "timeout"],
		description: "Run a bash command in the working directory.",
		notes: { timeout: "Seconds. No default." },
	},
	edit: {
		params: ["path", "edits"],
		description: "Replace exact text in one file.",
		notes: {
			edits: "Each is matched against the original file, not the result of earlier edits. Merge nearby changes into one.",
			"edits.oldText": "Exact text; unique in the file and not overlapping another oldText.",
		},
	},
	write: {
		params: ["path", "content"],
		description: "Create or overwrite a file.",
	},
	codemode: {
		params: ["code"],
		description: [
			"Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level `await` and `return` work. No Node, file system, network, or timers.",
			"- `await tools.<name>({ ...args })` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. A tool whose declaration returns an object resolves on failure too when it returned that object; check its fields. Calls still running when the script ends are cancelled.",
			'- Optional first line: `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`',
			"",
			"Globals:",
			"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script.",
			"- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
			"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.",
		].join("\n"),
	},
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy a JSON schema without its `description` annotations. Property names are kept as they are. */
function stripDescriptions(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(stripDescriptions);
	if (!isObject(schema)) return schema;
	const out: Json = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "description") continue;
		if (key === "properties" && isObject(value)) {
			out[key] = Object.fromEntries(Object.entries(value).map(([name, prop]) => [name, stripDescriptions(prop)]));
		} else {
			out[key] = stripDescriptions(value);
		}
	}
	return out;
}

/** The schema node a description belongs on: the non-null branch of a nullable, else the node itself. */
function describable(node: Json): Json {
	const branches = node.anyOf;
	if (Array.isArray(branches)) {
		const branch = branches.find((b) => isObject(b) && b.type !== "null");
		if (isObject(branch)) return branch;
	}
	return node;
}

function findParam(schema: Json, path: string): Json | undefined {
	let node: Json = schema;
	for (const name of path.split(".")) {
		node = describable(node);
		if (isObject(node.items)) node = node.items;
		const props = node.properties;
		if (!isObject(props) || !isObject(props[name])) return undefined;
		node = props[name];
	}
	return node;
}

function sameNames(schema: Json, expected: string[]): boolean {
	if (!isObject(schema.properties)) return false;
	const actual = Object.keys(schema.properties);
	return actual.length === expected.length && expected.every((name) => actual.includes(name));
}

/** Rewrite one tool definition, or return it unchanged when it is not a known tool in its known shape. */
export function leanTool<T>(tool: T): T {
	if (!isObject(tool) || typeof tool.name !== "string" || typeof tool.description !== "string") return tool;
	const rewrite = REWRITES[tool.name.toLowerCase()];
	const schemaKey = isObject(tool.input_schema) ? "input_schema" : "parameters";
	const schema = tool[schemaKey];
	if (!rewrite || !isObject(schema) || !sameNames(schema, rewrite.params)) return tool;

	const lean = stripDescriptions(schema) as Json;
	for (const [path, note] of Object.entries(rewrite.notes ?? {})) {
		const param = findParam(lean, path);
		if (!param) return tool;
		describable(param).description = note;
	}
	const marker = tool.description.indexOf(CODEMODE_MARKER);
	const suffix = marker >= 0 ? tool.description.slice(marker) : "";
	return { ...tool, description: rewrite.description + suffix, [schemaKey]: lean } as T;
}

/** Rewrite the tools of a provider request. Returns undefined when nothing changed. */
export function leanPayload(payload: unknown): unknown {
	if (!isObject(payload) || !Array.isArray(payload.tools)) return undefined;
	let changed = false;
	const tools = payload.tools.map((tool: unknown) => {
		// Chat-completions style providers nest the definition under `function`.
		const nested = isObject(tool) && isObject(tool.function);
		const before = nested ? (tool as Json).function : tool;
		const after = leanTool(before);
		if (after === before) return tool;
		changed = true;
		return nested ? { ...(tool as Json), function: after } : after;
	});
	return changed ? { ...payload, tools } : undefined;
}

export default function piLeanTools(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => leanPayload(event.payload));
}
