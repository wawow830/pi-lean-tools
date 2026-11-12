import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { leanPayload, leanTool, REWRITES } from "../index.ts";

const nullable = (type: string, description: string) => ({ anyOf: [{ type, description }, { type: "null" }] });

const read = {
	name: "Read",
	description:
		"Read the contents of a file. Supports text files and images.\n\nCodemode: `tools.read(args)` resolves to `string`.",
	strict: true,
	input_schema: {
		type: "object",
		required: ["path", "offset", "limit"],
		properties: {
			path: { type: "string", description: "Path to the file to read (relative or absolute)" },
			offset: nullable("number", "Line number to start reading from (1-indexed)"),
			limit: nullable("number", "Maximum number of lines to read"),
		},
		additionalProperties: false,
	},
};

const edit = {
	name: "Edit",
	description: "Edit a single file using exact text replacement.",
	input_schema: {
		type: "object",
		required: ["path", "edits"],
		properties: {
			path: { type: "string", description: "Path to the file to edit" },
			edits: {
				type: "array",
				description: "One or more targeted replacements.",
				items: {
					type: "object",
					required: ["oldText", "newText"],
					properties: {
						oldText: { type: "string", description: "Exact text for one targeted replacement." },
						newText: { type: "string", description: "Replacement text for this targeted edit." },
					},
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	},
};

describe("leanTool", () => {
	it("shortens the description and keeps pi's codemode line", () => {
		const out = leanTool(read);
		assert.equal(out.description, "Read a text file or image.\n\nCodemode: `tools.read(args)` resolves to `string`.");
		assert.equal(out.strict, true);
	});

	it("puts notes on the non-null branch and drops the rest", () => {
		const props = leanTool(read).input_schema.properties;
		assert.deepEqual(props.path, { type: "string" });
		assert.deepEqual(props.offset, nullable("number", REWRITES.read.notes!.offset));
		assert.deepEqual(props.limit, nullable("number", REWRITES.read.notes!.limit));
	});

	it("reaches into array items", () => {
		const edits = leanTool(edit).input_schema.properties.edits;
		assert.equal(edits.description, REWRITES.edit.notes!.edits);
		assert.deepEqual(edits.items.properties.oldText, { type: "string", description: REWRITES.edit.notes!["edits.oldText"] });
		assert.deepEqual(edits.items.properties.newText, { type: "string" });
		assert.deepEqual(edits.items.required, ["oldText", "newText"]);
	});

	it("leaves the input untouched", () => {
		const before = structuredClone(read);
		leanTool(read);
		assert.deepEqual(read, before);
	});

	it("keeps a parameter that happens to be named description", () => {
		const tool = {
			name: "write",
			description: "x",
			input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
		};
		const odd = { ...tool, input_schema: { type: "object", properties: { path: {}, description: { type: "string" } } } };
		assert.equal(leanTool(odd), odd);
		assert.equal(leanTool(tool).description, "Create or overwrite a file.");
	});

	it("skips unknown tools and changed shapes", () => {
		const other = { name: "grep", description: "Search", input_schema: { type: "object", properties: { pattern: {} } } };
		assert.equal(leanTool(other), other);
		const grown = structuredClone(read) as any;
		grown.input_schema.properties.encoding = { type: "string" };
		assert.equal(leanTool(grown), grown);
		const renamed = structuredClone(edit) as any;
		renamed.input_schema.properties.edits.items.properties = { find: { type: "string" }, newText: { type: "string" } };
		assert.equal(leanTool(renamed), renamed);
	});

	it("handles a `parameters` schema", () => {
		const { input_schema, ...rest } = read;
		const out = leanTool({ ...rest, parameters: input_schema });
		assert.deepEqual(out.parameters.properties.path, { type: "string" });
	});
});

describe("leanPayload", () => {
	it("returns undefined when there is nothing to rewrite", () => {
		assert.equal(leanPayload(undefined), undefined);
		assert.equal(leanPayload({ model: "m" }), undefined);
		assert.equal(leanPayload({ tools: [{ name: "grep", description: "Search", input_schema: { type: "object" } }] }), undefined);
	});

	it("rewrites known tools and keeps the rest of the payload", () => {
		const placeholder = { name: "__pi_deferred_placeholder__", description: "Reserved", defer_loading: true };
		const out = leanPayload({ model: "m", tools: [read, placeholder] }) as any;
		assert.equal(out.model, "m");
		assert.equal(out.tools[0].description.startsWith("Read a text file or image."), true);
		assert.equal(out.tools[1], placeholder);
	});

	it("rewrites definitions nested under `function`", () => {
		const { input_schema, ...rest } = read;
		const out = leanPayload({ tools: [{ type: "function", function: { ...rest, parameters: input_schema } }] }) as any;
		assert.equal(out.tools[0].type, "function");
		assert.deepEqual(out.tools[0].function.parameters.properties.path, { type: "string" });
	});

	it("trims codemode", () => {
		const codemode = {
			name: "codemode",
			description: "Run JavaScript that calls other tools. ...\n- `models`: classifiers and image generation.",
			input_schema: { type: "object", properties: { code: { type: "string", description: "Raw JavaScript source." } }, required: ["code"] },
		};
		const out = (leanPayload({ tools: [codemode] }) as any).tools[0];
		assert.equal(out.description, REWRITES.codemode.description);
		assert.deepEqual(out.input_schema.properties.code, { type: "string" });
	});
});
