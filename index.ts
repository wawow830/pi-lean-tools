/**
 * Shorter definitions for pi's built-in tools.
 *
 * pi describes each built-in tool in a paragraph and then repeats most of it on the parameters.
 * This extension rewrites the outgoing request so each tool has a one-line description and each
 * fact sits on the parameter it is about. Schemas, names and behaviour are untouched.
 *
 * A tool is rewritten only when its parameters are exactly the ones listed here, so a pi update
 * that changes a tool's shape falls back to pi's own definition instead of a stale one.
 *
 * Tools and prompt sections added by other extensions can be dropped by name. Configure in
 * ~/.pi/agent/settings.json:
 *
 * ```json
 * { "leanTools": { "dropTools": ["some_tool"], "dropSections": ["some_section"] } }
 * ```
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi appends the codemode return shape to each tool description after this marker. */
const CODEMODE_MARKER = "\n\nCodemode: ";
/** A codemode line that only restates codemode's default return type. */
const CODEMODE_DEFAULT = /^\n\nCodemode: `tools\.\w+\(args\)` resolves to a string\.$/;
/** pi's stand-in for deferred tools. It is only useful while a tool search can load them. */
const DEFERRED_PLACEHOLDER = "__pi_deferred_placeholder__";
const TOOL_SEARCH = "tool_search";

export interface LeanOptions {
	/** Tool names to leave out of the request. */
	dropTools: string[];
	/** Prompt sections to leave out of the request, named by their `<tag>`. */
	dropSections: string[];
}

export const NO_DROPS: LeanOptions = { dropTools: [], dropSections: [] };

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** Read `leanTools` from pi's settings; anything malformed counts as empty. */
export function readOptions(settings: Record<string, unknown>): LeanOptions {
	const raw = isObject(settings.leanTools) ? settings.leanTools : {};
	return { dropTools: stringList(raw.dropTools), dropSections: stringList(raw.dropSections) };
}

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
	const codemodeLine = marker >= 0 ? tool.description.slice(marker) : "";
	const suffix = CODEMODE_DEFAULT.test(codemodeLine) ? "" : codemodeLine;
	return { ...tool, description: rewrite.description + suffix, [schemaKey]: lean } as T;
}

function toolName(tool: unknown): string {
	if (!isObject(tool)) return "";
	const def = isObject(tool.function) ? tool.function : tool;
	return typeof def.name === "string" ? def.name.toLowerCase() : "";
}

/** Remove each `<name>…</name>` section from prompt text. */
export function dropSections(text: string, names: string[]): string {
	let out = text;
	for (const name of names) {
		const tag = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`\\n*<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
	}
	return out;
}

/** Apply `edit` to prompt text held as a string or as text blocks. Returns the input when nothing changed. */
function mapText(content: unknown, edit: (text: string) => string): unknown {
	if (typeof content === "string") return edit(content);
	if (!Array.isArray(content)) return content;
	let changed = false;
	const blocks = content.map((block: unknown) => {
		if (!isObject(block) || typeof block.text !== "string") return block;
		const text = edit(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? blocks : content;
}

function leanTools(tools: unknown[], drop: string[]): unknown[] {
	const dropped = new Set(drop.map((name) => name.toLowerCase()));
	// Nothing can load a deferred tool without a tool search, so the stand-in is dead weight.
	if (!tools.some((tool) => toolName(tool) === TOOL_SEARCH)) dropped.add(DEFERRED_PLACEHOLDER);
	let changed = false;
	const out: unknown[] = [];
	for (const tool of tools) {
		if (dropped.has(toolName(tool))) {
			changed = true;
			continue;
		}
		// Chat-completions style providers nest the definition under `function`.
		const nested = isObject(tool) && isObject(tool.function);
		const before = nested ? (tool as Json).function : tool;
		const after = leanTool(before);
		if (after !== before) changed = true;
		out.push(after === before ? tool : nested ? { ...(tool as Json), function: after } : after);
	}
	return changed ? out : tools;
}

/** Rewrite a provider request. Returns undefined when nothing changed. */
export function leanPayload(payload: unknown, options: LeanOptions = NO_DROPS): unknown {
	if (!isObject(payload)) return undefined;
	const out: Json = { ...payload };
	let changed = false;
	const set = (key: string, value: unknown) => {
		if (value === payload[key]) return;
		out[key] = value;
		changed = true;
	};

	if (Array.isArray(payload.tools)) set("tools", leanTools(payload.tools, options.dropTools));

	if (options.dropSections.length > 0) {
		const edit = (text: string) => dropSections(text, options.dropSections);
		for (const key of ["system", "instructions"]) {
			if (key in payload) set(key, mapText(payload[key], edit));
		}
		if (Array.isArray(payload.messages)) {
			let touched = false;
			const messages = payload.messages.map((message: unknown) => {
				if (!isObject(message) || (message.role !== "system" && message.role !== "developer")) return message;
				const content = mapText(message.content, edit);
				if (content === message.content) return message;
				touched = true;
				return { ...message, content };
			});
			if (touched) set("messages", messages);
		}
	}
	return changed ? out : undefined;
}

export default function piLeanTools(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) =>
		leanPayload(event.payload, readOptions(pi.getSettings() as unknown as Record<string, unknown>)),
	);
}
