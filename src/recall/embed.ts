/**
 * Local embedding using node-llama-cpp.
 * Uses a small 300M parameter model for fast local embeddings.
 */

import { getLlama, resolveModelFile, LlamaLogLevel } from "node-llama-cpp";
import type { Llama, LlamaModel, LlamaEmbeddingContext } from "node-llama-cpp";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const DEFAULT_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const MODEL_CACHE_DIR = join(homedir(), ".cache", "bob", "models");

let llama: Llama | null = null;
let model: LlamaModel | null = null;
let context: LlamaEmbeddingContext | null = null;

export async function ensureModel(): Promise<string> {
  if (!existsSync(MODEL_CACHE_DIR)) {
    mkdirSync(MODEL_CACHE_DIR, { recursive: true });
  }
  return resolveModelFile(DEFAULT_MODEL, { directory: MODEL_CACHE_DIR, download: "auto" });
}

export async function embed(text: string): Promise<Float32Array> {
  if (!context) {
    if (!llama) {
      llama = await getLlama({ logLevel: LlamaLogLevel.error });
    }
    if (!model) {
      const modelPath = await ensureModel();
      model = await llama.loadModel({ modelPath });
    }
    context = await model.createEmbeddingContext();
  }

  // Clamp to context size
  const maxTokens = context.model.trainContextSize ?? 512;
  const tokens = context.model.tokenize(text, true, "trimLeadingSpace");
  const safeTokens = tokens.slice(0, maxTokens - 2);
  const safeText = tokens.length > safeTokens.length
    ? context.model.detokenize(safeTokens, true)
    : text;

  const embedding = await context.getEmbeddingFor(safeText);
  const vector = embedding.vector;

  if (vector instanceof Float32Array) return vector;
  if (Array.isArray(vector)) return Float32Array.from(vector);
  return new Float32Array(vector as ArrayLike<number>);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function cleanup(): Promise<void> {
  if (context) {
    await context.dispose();
    context = null;
  }
  if (model) {
    await model.dispose();
    model = null;
  }
}
