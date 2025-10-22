import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

type ReplacementTarget = {
	description: string;
	startMarker: string;
	suffixMatcher?: RegExp;
};

function extractBlock(source: string, target: ReplacementTarget) {
	const start = source.indexOf(target.startMarker);
	if (start === -1) {
		throw new Error(`无法在源代码中找到标记：${target.startMarker}`);
	}
	let lineStart = start;
	while (lineStart > 0 && source[lineStart - 1] !== "\n")
		lineStart--;
	const leadingIndent = source.slice(lineStart, start);
	const braceStart = source.indexOf("{", start);
	if (braceStart === -1) {
		throw new Error(`未能在标记后找到左花括号：${target.startMarker}`);
	}
	let index = braceStart;
	let depth = 0;
	while (index < source.length) {
		const ch = source[index];
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) {
				index++;
				break;
			}
		}
		index++;
	}
	if (depth !== 0) {
		throw new Error(`括号未正确闭合：${target.startMarker}`);
	}
	let end = index;
	if (target.suffixMatcher) {
		const slice = source.slice(end);
		const matched = target.suffixMatcher.exec(slice);
		if (!matched || matched.index !== 0) {
			throw new Error(`未能在块末尾匹配附加后缀：${target.description}`);
		}
		end += matched[0].length;
	}
	return {
		start: lineStart,
		end,
		snippet: source.slice(lineStart, end),
		leadingIndent,
	};
}

function runAstGrep(snippet: string) {
	const tempDir = mkdtempSync(join(tmpdir(), "ast-grep-"));
	try {
		const tempFile = join(tempDir, "snippet.js");
		writeFileSync(tempFile, snippet, "utf8");
		const result = spawnSync(
			"sg",
			["scan", "--config", "sgconfig.yml", "--update-all", tempFile],
			{ cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
		);
		if (result.status !== 0) {
			throw new Error(
				`执行 ast-grep 失败：${result.error ?? ""}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
			);
		}
		return readFileSync(tempFile, "utf8");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function main() {
	const rawPath = join("artifacts", "droid.raw.js");
	const outputPath = join("artifacts", "droid.generated.js");
	const content = readFileSync(rawPath, "utf8");
	let updated = content;
	const targets: ReplacementTarget[] = [
		{
			description: "ripgrep 解析函数",
			startMarker: "G$H = zFA.default(() => {",
			suffixMatcher: /^\s*\);/,
		},
		{
			description: "证书加载函数 WX$",
			startMarker: "async function WX$() {",
		},
	];
	for (const target of targets) {
		const { start, end, snippet, leadingIndent } = extractBlock(updated, target);
		const normalized = snippet
			.split("\n")
			.map((line: string) =>
				line.startsWith(leadingIndent) ? line.slice(leadingIndent.length) : line,
			)
			.join("\n");
		const transformed = runAstGrep(normalized);
		const hadEndingNewline = snippet.endsWith("\n");
		const transformedLines = transformed.split("\n");
		while (
			transformedLines.length > 0 &&
			transformedLines[transformedLines.length - 1] === ""
		)
			transformedLines.pop();
		const reindentedBody = transformedLines
			.map((line) => (line.length === 0 ? line : leadingIndent + line))
			.join("\n");
		const reindented = hadEndingNewline ? `${reindentedBody}\n` : reindentedBody;
		if (snippet === reindented) {
			console.log(`未检测到需要更新的内容：${target.description}`);
			continue;
		}
		console.log(`已更新片段：${target.description}`);
		updated = `${updated.slice(0, start)}${reindented}${updated.slice(end)}`;
	}
	if (updated === content) {
		console.log("文件内容无需变更。");
		return;
	}
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, updated, "utf8");
	console.log(`已生成 ${outputPath}，可用于与现有 droid.js 比较。`);
}

main();
