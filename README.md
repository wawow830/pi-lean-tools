# pi-lean-tools

A [pi](https://pi.dev) extension that sends shorter definitions for the built-in tools.

pi describes each built-in tool in a paragraph and then repeats most of it on the parameters. This extension rewrites the outgoing request so each tool has a one-line description and each fact sits on the parameter it is about. Tool names, schemas and behaviour are untouched.

Measured on pi 1.5.2 with `read`, `bash`, `edit`, `write` and `codemode` active, the five definitions drop from 1,851 to 1,259 input tokens per request.

## Install

```bash
git clone <this repository> pi-lean-tools
pi install ./pi-lean-tools
# or try it for one run
pi -e ./pi-lean-tools
```

## What the model sees

```
read       Read a text file or image.
  offset   1-indexed line to start from
  limit    Max lines. Long files are truncated; continue with offset.

bash       Run a bash command in the working directory.
  timeout  Seconds. No default.

edit       Replace exact text in one file.
  edits    Each is matched against the original file, not the result of earlier edits. Merge nearby changes into one.
  oldText  Exact text; unique in the file and not overlapping another oldText.

write      Create or overwrite a file.
```

Parameters with no note (`path`, `command`, `content`, `newText`) carry only their name and type. The line pi appends to each description for codemode (`Codemode: tools.read(args) resolves to …`) is kept.

`codemode` keeps its description except for three things: the sentence about how output is framed (`==> text N/M <==`, `<console_output>`, the temp file `image()` writes), the `models` line, and the note on `code`.

## What is left out

- The exact truncation limits for `read` and `bash` (2,000 lines or 50KB).
- The list of image formats `read` accepts.
- `edit`'s advice not to include large unchanged regions.
- That codemode can reach classifiers and image generation through `models`. Remove the `codemode` entry from `REWRITES` in `index.ts` if you use them.

## How it works

The extension handles `before_provider_request` and replaces the `tools` array in the payload. A tool is rewritten only when its top-level parameters are exactly the ones listed in `REWRITES`, and every noted parameter exists. If a pi update changes a tool's shape, that tool is sent with pi's own definition.

The rewrite happens after pi builds the request, so pi's own view of its tools (`pi.getAllTools()`, the `<tools>` section of the default system prompt) does not change. An extension that records the payload in an earlier `before_provider_request` handler sees pi's definitions, not these; load this extension first if another one replays requests.

## License

MIT
