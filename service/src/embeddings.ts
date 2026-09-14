/**
 * Local embeddings with gte-small (384-dim) via Transformers.js — NO API key.
 * The SAME model Supabase exposes built-in inside edge functions (`Supabase.ai`),
 * so ingest-side vectors (here) and query-side vectors (edge) are compatible.
 */
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

export const EMBEDDING_MODEL = "Supabase/gte-small";
export const EMBEDDING_DIMS = 384;

let _pipe: Promise<FeatureExtractionPipeline> | null = null;
function extractor() {
  if (!_pipe) _pipe = pipeline("feature-extraction", EMBEDDING_MODEL);
  return _pipe;
}

/** Embed a batch of texts -> array of 384-dim normalized vectors. */
export async function embed(texts: string[]): Promise<number[][]> {
  const ex = await extractor();
  const out = await ex(texts, { pooling: "mean", normalize: true });
  // out.dims = [n, 384]; out.data is a flat Float32Array
  const [n, d] = out.dims as [number, number];
  const flat = out.data as Float32Array;
  const vecs: number[][] = [];
  for (let i = 0; i < n; i++) vecs.push(Array.from(flat.subarray(i * d, (i + 1) * d)));
  return vecs;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}

/** Cosine similarity for already-normalized vectors (= dot product). */
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
