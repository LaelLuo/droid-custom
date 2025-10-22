#!/usr/bin/env bun

import { promises as fs } from "fs";
import path from "path";

type StringPointer = {
  offset: number;
  length: number;
};

type ModuleRecord = {
  originalPath: string;
  contents: Uint8Array;
  sourcemap: Uint8Array | null;
  bytecode: Uint8Array | null;
  encoding: number;
  loader: number;
  moduleFormat: number;
  side: number;
};

type ParsedStandalone = {
  modules: ModuleRecord[];
  entryPointId: number;
  compileExecArgv: string;
};

const TRAILER = "\n---- Bun! ----\n";
const TRAILER_BYTES = new TextEncoder().encode(TRAILER);
const OFFSETS_SIZE = 32;
const MODULE_RECORD_SIZE = 40;
const textDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const loaderDefaultExtensions: Record<number, string> = {
  0: ".jsx",
  1: ".js",
  2: ".ts",
  3: ".tsx",
  4: ".css",
  5: "", // file/binary assets keep original name or fall back to .bin
  6: ".json",
  7: ".json",
  8: ".toml",
  9: ".wasm",
  10: ".node",
  11: ".txt",
  12: ".txt",
  13: ".txt",
  14: ".sh",
  15: ".sqlite",
  16: ".sqlite",
  17: ".html",
  18: ".yaml",
};

function usage(): never {
  console.error("用法: bun run scripts/extract-standalone.ts <bun生成的exe路径> [输出目录]");
  process.exit(1);
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length === 0) usage();

  const exePath = path.resolve(args[0]);
  const outputDir = path.resolve(args[1] ?? `${path.basename(exePath)}-extracted`);

  const exeBytes = new Uint8Array(await Bun.file(exePath).arrayBuffer());
  const embedded = extractEmbeddedData(exeBytes);
  const parsed = parseStandalone(embedded);

  await writeOutputs(parsed, outputDir);

  console.log(`已解析 ${parsed.modules.length} 个模块，结果输出在: ${outputDir}`);
  if (parsed.compileExecArgv.length > 0) {
    console.log(`compile_exec_argv: ${parsed.compileExecArgv}`);
  }
}

function extractEmbeddedData(fileBytes: Uint8Array): Uint8Array {
  try {
    return extractBunSection(fileBytes);
  } catch (peErr) {
    const fallback = extractTrailerAppendedBlob(fileBytes);
    if (fallback) return fallback;
    const message =
      peErr instanceof Error ? peErr.message : "未能从 PE 结构读取嵌入数据";
    throw new Error(
      `${message}；同时也未检测到结尾的 Bun trailer。请确认该可执行文件确实由 "bun build --compile" 生成。`,
    );
  }
}

function extractBunSection(fileBytes: Uint8Array): Uint8Array {
  const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);

  if (fileBytes.length < 0x40 || view.getUint16(0, true) !== 0x5a4d) {
    throw new Error("文件不是有效的 PE (MZ) 可执行文件");
  }

  const peHeaderOffset = view.getUint32(0x3c, true);
  if (peHeaderOffset + 24 > fileBytes.length) {
    throw new Error("PE 头越界，文件可能已损坏");
  }

  const signature = view.getUint32(peHeaderOffset, true);
  if (signature !== 0x4550) {
    throw new Error("未找到 PE\\0\\0 签名，确定这是 Windows 的 bun 可执行文件吗？");
  }

  const numberOfSections = view.getUint16(peHeaderOffset + 6, true);
  const sizeOfOptionalHeader = view.getUint16(peHeaderOffset + 20, true);

  const sectionTableOffset = peHeaderOffset + 24 + sizeOfOptionalHeader;
  if (sectionTableOffset > fileBytes.length) {
    throw new Error("节表位置非法");
  }

  for (let i = 0; i < numberOfSections; i++) {
    const sectionOffset = sectionTableOffset + i * 40;
    if (sectionOffset + 40 > fileBytes.length) {
      throw new Error("节表记录越界");
    }

    const nameBytes = fileBytes.subarray(sectionOffset, sectionOffset + 8);
    const sectionName = decodeAsciiNullTerminated(nameBytes);
    if (sectionName !== ".bun") continue;

    const sizeOfRawData = view.getUint32(sectionOffset + 16, true);
    const pointerToRawData = view.getUint32(sectionOffset + 20, true);

    if (
      pointerToRawData + sizeOfRawData > fileBytes.length ||
      pointerToRawData + 4 > fileBytes.length
    ) {
      throw new Error(".bun 节数据越界");
    }

    const dataLength = view.getUint32(pointerToRawData, true);
    const dataStart = pointerToRawData + 4;
    const dataEnd = dataStart + dataLength;
    if (dataEnd > pointerToRawData + sizeOfRawData || dataEnd > fileBytes.length) {
      throw new Error(".bun 节的长度前缀与实际数据不匹配");
    }

    return fileBytes.subarray(dataStart, dataEnd);
  }

  throw new Error("未在 PE 文件中找到 .bun 节，无法解析嵌入数据");
}

function extractTrailerAppendedBlob(fileBytes: Uint8Array): Uint8Array | null {
  if (fileBytes.length < TRAILER_BYTES.length + OFFSETS_SIZE + 8) {
    return null;
  }

  const trailerIndex = lastIndexOfSubarray(fileBytes, TRAILER_BYTES);
  if (trailerIndex === -1) {
    return null;
  }

  const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
  const lengthFieldOffset = fileBytes.length - 8;
  const totalBytesBig = view.getBigUint64(lengthFieldOffset, true);
  if (totalBytesBig === 0n) {
    return null;
  }

  const fileLengthBig = BigInt(fileBytes.length);
  if (totalBytesBig === 0n || totalBytesBig > fileLengthBig) {
    return null;
  }

  const totalBytes =
    totalBytesBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(totalBytesBig);

  if (totalBytes === Number.MAX_SAFE_INTEGER && totalBytesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  const start = fileBytes.length - 8 - totalBytes;
  if (start < 0) {
    return null;
  }

  const blob = fileBytes.subarray(start, fileBytes.length - 8);
  if (lastIndexOfSubarray(blob, TRAILER_BYTES) === -1) {
    return null;
  }

  return blob;
}

function parseStandalone(blob: Uint8Array): ParsedStandalone {
  if (blob.length < TRAILER_BYTES.length + OFFSETS_SIZE) {
    throw new Error("嵌入数据长度过短，缺少尾部标记或偏移表");
  }

  const trailerIndex = lastIndexOfSubarray(blob, TRAILER_BYTES);
  if (trailerIndex === -1) {
    throw new Error("未找到 bun 末尾标记，文件可能不是 bun build --compile 生成的");
  }

  const offsetsPos = trailerIndex - OFFSETS_SIZE;
  if (offsetsPos < 0) {
    throw new Error("偏移数据位置非法");
  }

  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const byteCountBig = view.getBigUint64(offsetsPos, true);
  if (byteCountBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("嵌入数据过大，超出 JS 可安全表示的范围");
  }
  const byteCount = Number(byteCountBig);

  const modulesPtr = readPointer(view, offsetsPos + 8);
  const entryPointId = view.getUint32(offsetsPos + 16, true);
  const compileExecArgvPtr = readPointer(view, offsetsPos + 20);

  if (byteCount > blob.length) {
    throw new Error("偏移表中的 byte_count 超出嵌入数据范围");
  }

  const payload = blob.subarray(0, byteCount);
  const modulesEnd = modulesPtr.offset + modulesPtr.length;
  if (modulesEnd > payload.length) {
    throw new Error("模块表越界，嵌入数据可能损坏");
  }

  let recordSize = MODULE_RECORD_SIZE;
  if (modulesPtr.length % recordSize !== 0) {
    const alternateSize = 36;
    if (modulesPtr.length % alternateSize === 0) {
      recordSize = alternateSize;
    } else {
      throw new Error("模块记录长度不是已知的结构尺寸整数倍 (36 或 40 字节)");
    }
  }

  const recordCount = modulesPtr.length / recordSize;
  const modules: ModuleRecord[] = [];

  for (let i = 0; i < recordCount; i++) {
    const base = modulesPtr.offset + i * recordSize;
    const namePtr = readPointerFromPayload(payload, base);
    const contentsPtr = readPointerFromPayload(payload, base + 8);
    const sourcemapPtr = readPointerFromPayload(payload, base + 16);
    const bytecodePtr = readPointerFromPayload(payload, base + 24);

    const encoding = payload[base + 32] ?? 0;
    const loader = payload[base + 33] ?? 5;
    const moduleFormat = payload[base + 34] ?? 0;
    const side = payload[base + 35] ?? 0;

    const originalPath = decodeUtf8(payload, namePtr);
    const contents = slicePointer(payload, contentsPtr);
    const sourcemap = sourcemapPtr.length > 0 ? slicePointer(payload, sourcemapPtr) : null;
    const bytecode = bytecodePtr.length > 0 ? slicePointer(payload, bytecodePtr) : null;

    modules.push({
      originalPath,
      contents,
      sourcemap,
      bytecode,
      encoding,
      loader,
      moduleFormat,
      side,
    });
  }

  const compileExecArgv = decodeUtf8(payload, compileExecArgvPtr);

  return {
    modules,
    entryPointId,
    compileExecArgv,
  };
}

async function writeOutputs(parsed: ParsedStandalone, outputDir: string) {
  const resolvedOutput = path.resolve(outputDir);
  const resolvedOutputWithSep = ensureTrailingSep(resolvedOutput);
  await fs.mkdir(resolvedOutput, { recursive: true });

  const metadata: Array<Record<string, unknown>> = [];
  const usedPaths = new Map<string, number>();

  for (const [index, module] of parsed.modules.entries()) {
    const relPath = chooseRelativePath(module, index, usedPaths);
    const targetPath = path.resolve(resolvedOutput, relPath);

    if (!targetPath.startsWith(resolvedOutputWithSep) && targetPath !== resolvedOutput) {
      throw new Error(`生成的路径越界: ${targetPath}`);
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, module.contents);

    if (module.sourcemap) {
      await fs.writeFile(`${targetPath}.map`, module.sourcemap);
    }

    if (module.bytecode) {
      await fs.writeFile(`${targetPath}.bytecode.bin`, module.bytecode);
    }

    metadata.push({
      index,
      originalPath: module.originalPath,
      relativePath: relPath,
      loader: module.loader,
      encoding: module.encoding,
      moduleFormat: module.moduleFormat,
      side: module.side,
      hasSourcemap: module.sourcemap !== null,
      hasBytecode: module.bytecode !== null,
    });
  }

  if (parsed.compileExecArgv.length > 0) {
    await fs.writeFile(
      path.resolve(resolvedOutput, "__compile_exec_argv.txt"),
      parsed.compileExecArgv + "\n",
      "utf8",
    );
  }

  await fs.writeFile(
    path.resolve(resolvedOutput, "metadata.json"),
    JSON.stringify(
      {
        modules: metadata,
        entryPointId: parsed.entryPointId,
        compileExecArgv: parsed.compileExecArgv,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function chooseRelativePath(
  module: ModuleRecord,
  index: number,
  used: Map<string, number>,
): string {
  let candidate = sanitizeModulePath(module.originalPath);
  if (!candidate) {
    const fallbackExt = loaderDefaultExtensions[module.loader] ?? ".bin";
    candidate = `module-${index.toString().padStart(4, "0")}${fallbackExt}`;
  }

  candidate = candidate.replace(/^[/\\]+/, "");
  if (candidate === "" || path.isAbsolute(candidate)) {
    const fallbackExt = loaderDefaultExtensions[module.loader] ?? ".bin";
    candidate = `module-${index.toString().padStart(4, "0")}${fallbackExt}`;
  }

  const normalized = candidate.split(/[\\/]+/).filter(Boolean);
  let finalPath = normalized.join(path.sep);
  if (!finalPath) {
    finalPath = `module-${index.toString().padStart(4, "0")}`;
  }

  const key = finalPath.toLowerCase();
  if (used.has(key)) {
    const count = used.get(key)! + 1;
    used.set(key, count);
    const ext = path.extname(finalPath);
    const base = finalPath.slice(0, finalPath.length - ext.length);
    return `${base}.${count}${ext}`;
  }
  used.set(key, 1);
  return finalPath;
}

function sanitizeModulePath(original: string): string {
  let rel = original.replace(/\0/g, "");

  const prefixes = [
    /^B:\/~BUN\/root\//i,
    /^[A-Z]:\/~BUN\/root\//i,
    /^\/\$bunfs\/root\//,
    /^B:\/~BUN\//i,
    /^[A-Z]:\/~BUN\//i,
    /^\/\$bunfs\//,
    /^\.\/+/,
    /^root\//,
    /^\/root\//,
  ];

  for (const prefix of prefixes) {
    if (prefix.test(rel)) {
      rel = rel.replace(prefix, "");
    }
  }

  rel = rel.replace(/[:*?"<>|]/g, "_");
  rel = rel.replace(/\r/g, "");
  rel = rel.replace(/\\/g, "/");
  rel = rel.replace(/^\.+/, "");

  const parts = rel.split("/").filter((part) => part !== "" && part !== "..");
  return parts.join("/");
}

function decodeUtf8(bytes: Uint8Array, ptr: StringPointer): string {
  if (ptr.length === 0) return "";
  const slice = slicePointer(bytes, ptr);
  return textDecoder.decode(slice);
}

function slicePointer(bytes: Uint8Array, ptr: StringPointer): Uint8Array {
  if (ptr.length === 0) return new Uint8Array(0);
  const end = ptr.offset + ptr.length;
  if (end > bytes.length) {
    throw new Error("字符串指针越界，嵌入数据损坏");
  }
  return bytes.subarray(ptr.offset, end);
}

function readPointer(view: DataView, offset: number): StringPointer {
  const pointerOffset = view.getUint32(offset, true);
  const pointerLength = view.getUint32(offset + 4, true);
  return { offset: pointerOffset, length: pointerLength };
}

function readPointerFromPayload(bytes: Uint8Array, offset: number): StringPointer {
  if (offset + 8 > bytes.length) {
    throw new Error("模块表中的指针越界");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return {
    offset: view.getUint32(0, true),
    length: view.getUint32(4, true),
  };
}

function decodeAsciiNullTerminated(bytes: Uint8Array): string {
  let length = 0;
  while (length < bytes.length && bytes[length] !== 0) length += 1;
  return textDecoder.decode(bytes.subarray(0, length));
}

function lastIndexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  outer: for (let i = haystack.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function ensureTrailingSep(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

await main().catch((err) => {
  console.error(`解析失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
