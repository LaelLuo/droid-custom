#!/usr/bin/env bun

import {
	access,
	copyFile,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "fs/promises";
import { createHash } from "crypto";
import path from "path";

const INSTALLER_URL = "https://app.factory.ai/cli/windows";
const ARTIFACTS_DIR = path.resolve("artifacts");
const VERSION_FILE = path.join(ARTIFACTS_DIR, "droid.version.json");
const DROID_EXE = path.join(ARTIFACTS_DIR, "droid.exe");
const DROID_JS = path.join(ARTIFACTS_DIR, "droid.js");
const DROID_RAW = path.join(ARTIFACTS_DIR, "droid.raw.js");
const DROID_OLD = path.join(ARTIFACTS_DIR, "droid.old.js");
const DROID_GENERATED = path.join(ARTIFACTS_DIR, "droid.generated.js");

type InstallerMeta = {
	version: string;
	baseUrl: string;
	binaryName: string;
};

type VersionSnapshot = {
	version: string;
	architecture: string;
	sourceUrl: string;
	updatedAt: string;
};

async function main() {
	const args = new Set(Bun.argv.slice(2));
	const force = args.has("--force");

	const architecture = resolveArchitecture();
	console.log(`检测到架构: ${architecture}`);

	await mkdir(ARTIFACTS_DIR, { recursive: true });

	const installerScript = await fetchInstallerScript();
	const meta = parseInstallerScript(installerScript);
	const downloadUrl = buildDownloadUrl(meta, architecture);
	const shaUrl = `${downloadUrl}.sha256`;

	console.log(`最新版本: ${meta.version}`);
	console.log(`下载地址: ${downloadUrl}`);

	const current = await readCurrentVersion();
	if (!force && current && current.version === meta.version && current.architecture === architecture) {
		console.log(`当前 artifacts 已是最新版本 v${current.version} (${current.architecture})，跳过下载。`);
		return;
	}

	const [binary, expectedSha] = await Promise.all([
		downloadBinary(downloadUrl),
		downloadSha256(shaUrl),
	]);

	verifySha(binary, expectedSha);
	await writeFile(DROID_EXE, binary);
	console.log(`已下载 droid.exe -> ${DROID_EXE}`);

	await runExtractor();
	await rotateArtifacts();

	const rulesApplied = await runApplyRules();
	if (rulesApplied) {
		await promoteGenerated();
	} else {
		console.warn("跳过规则应用，保留原始 dump 作为当前版本。");
	}

	await maybeFormat(DROID_JS);
	if (await fileExists(DROID_OLD)) {
		await maybeFormat(DROID_OLD);
	}

	await writeVersionSnapshot({
		version: meta.version,
		architecture,
		sourceUrl: downloadUrl,
		updatedAt: new Date().toISOString(),
	});

	console.log("更新完成。");
}

async function fetchInstallerScript(): Promise<string> {
	const res = await fetch(INSTALLER_URL);
	if (!res.ok) {
		throw new Error(`获取安装脚本失败: ${res.status} ${res.statusText}`);
}
	return res.text();
}

function parseInstallerScript(content: string): InstallerMeta {
	const versionMatch = content.match(/\$version\s*=\s*"([^"]+)"/);
	if (!versionMatch) {
		throw new Error("无法从安装脚本中解析版本号");
	}
	const baseUrlMatch = content.match(/\$baseUrl\s*=\s*"([^"]+)"/);
	const binaryNameMatch = content.match(/\$binaryName\s*=\s*"([^"]+)"/);
	return {
		version: versionMatch[1],
		baseUrl: baseUrlMatch?.[1] ?? "https://downloads.factory.ai",
		binaryName: binaryNameMatch?.[1] ?? "droid.exe",
	};
}

function buildDownloadUrl(meta: InstallerMeta, architecture: string): string {
	const base = meta.baseUrl.replace(/\/+$/, "");
	return `${base}/factory-cli/releases/${meta.version}/windows/${architecture}/${meta.binaryName}`;
}

function resolveArchitecture(): string {
	const arch = process.arch.toLowerCase();
	if (arch === "x64" || arch === "amd64") return "x64";
	if (arch === "arm64") return "arm64";
	throw new Error(`暂不支持当前架构: ${process.arch}`);
}

async function downloadBinary(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`下载失败: ${res.status} ${res.statusText}`);
	}
	const buffer = await res.arrayBuffer();
	return new Uint8Array(buffer);
}

async function downloadSha256(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`获取 SHA256 校验值失败: ${res.status} ${res.statusText}`);
	}
	const text = (await res.text()).trim();
	const firstToken = text.split(/\s+/)[0]?.trim();
	if (!firstToken) {
		throw new Error("SHA256 文件内容为空");
	}
	return firstToken.toLowerCase();
}

function verifySha(binary: Uint8Array, expected: string) {
	const actual = createHash("sha256").update(binary).digest("hex");
	if (actual !== expected.toLowerCase()) {
		throw new Error(
			`SHA256 校验失败，期望 ${expected.toLowerCase()} 得到 ${actual}`,
		);
	}
	console.log("SHA256 校验通过");
}

async function runExtractor() {
	console.log("执行 dump：scripts/extract-standalone.ts");
	await runSubprocess([
		"bun",
		path.join("scripts", "extract-standalone.ts"),
		DROID_EXE,
		ARTIFACTS_DIR,
	]);
}

async function rotateArtifacts() {
	if (await fileExists(DROID_JS)) {
		await rm(DROID_OLD, { force: true });
		await rename(DROID_JS, DROID_OLD);
		console.log(`已备份上一版本 -> ${DROID_OLD}`);
	}

	if (!(await fileExists(DROID_EXE))) {
		throw new Error("dump 结果缺少 droid.exe，无法继续");
	}

	await rename(DROID_EXE, DROID_JS);
	await copyFile(DROID_JS, DROID_RAW);
	console.log(`已生成新的原始版本 -> ${DROID_RAW}`);
}

async function runApplyRules() {
	console.log("执行 ast-grep 规则：scripts/apply-rules.ts");
	await rm(DROID_GENERATED, { force: true });
	try {
		await runSubprocess(["bun", path.join("scripts", "apply-rules.ts")]);
		return true;
	} catch (error) {
		console.warn(
			`ast-grep 规则执行失败，错误信息：${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

async function promoteGenerated() {
	if (!(await fileExists(DROID_GENERATED))) {
		console.log("规则未生成 droid.generated.js，保留原始 dump 作为当前版本。");
		return;
	}
	const generated = await readFile(DROID_GENERATED);
	await writeFile(DROID_JS, generated);
	console.log(`已应用规则生成的版本 -> ${DROID_JS}`);
}

async function maybeFormat(target: string) {
	try {
		await runSubprocess(["biome", "format", "--write", target]);
		console.log(`已使用 Biome 格式化 ${target}`);
	} catch (error) {
		if (isCommandNotFound(error)) {
			console.warn("本地未检测到 biome，可手动格式化。");
		} else {
			throw error;
		}
	}
}

async function runSubprocess(cmd: string[]) {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn({
			cmd,
			cwd: process.cwd(),
			stdout: "inherit",
			stderr: "inherit",
		});
	} catch (error) {
		throw error;
	}
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const err = new Error(`${cmd.join(" ")} 执行失败，退出码 ${exitCode}`);
		(err as Error & { exitCode: number }).exitCode = exitCode;
		throw err;
	}
}

function isCommandNotFound(error: unknown): boolean {
	if (error && typeof error === "object") {
		const maybeErr = error as { code?: unknown };
		if (maybeErr.code === "ENOENT") return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return /ENOENT/i.test(message);
}

async function fileExists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

async function readCurrentVersion(): Promise<VersionSnapshot | null> {
	try {
		const raw = await readFile(VERSION_FILE, "utf8");
		const parsed = JSON.parse(raw) as VersionSnapshot;
		if (typeof parsed.version === "string" && typeof parsed.architecture === "string") {
			return parsed;
		}
	} catch {
		// ignore
	}
	return null;
}

async function writeVersionSnapshot(snapshot: VersionSnapshot) {
	await writeFile(VERSION_FILE, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
	console.log(`已写入版本信息 -> ${VERSION_FILE}`);
}

await main().catch((error) => {
	console.error(
		`更新失败: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
