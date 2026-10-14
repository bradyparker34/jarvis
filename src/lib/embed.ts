/**
 * Embeddings, local by default.
 *
 * all-MiniLM-L6-v2 runs on CPU through transformers.js: no API key, no network
 * after the first model download, and nothing you ingest is sent anywhere. For
 * a database holding your employer's correspondence and your own messages,
 * that property matters more than the few points of retrieval quality a hosted
 * model would add.
 *
 * Set EMBED_PROVIDER=openai if you decide otherwise, or =none to run on
 * keyword search alone.
 */

export const EMBED_DIM = 384;

type Embedder = (texts: string[]) => Promise<number[][]>;

let embedder: Embedder | undefined;
let warned = false;

async function loadLocal(): Promise<Embedder> {
  const { pipeline } = await import("@huggingface/transformers");
  const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "fp32",
  });
  return async (texts) => {
    const out = await extract(texts, { pooling: "mean", normalize: true });
    return out.tolist() as number[][];
  };
}

function loadOpenAI(): Embedder {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("EMBED_PROVIDER=openai but OPENAI_API_KEY is unset.");
  return async (texts) => {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      // 384 dims keeps the schema and the local model interchangeable.
      body: JSON.stringify({ model: "text-embedding-3-small", input: texts, dimensions: EMBED_DIM }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  };
}

export function embeddingsEnabled(): boolean {
  return (process.env.EMBED_PROVIDER ?? "local") !== "none";
}

/**
 * Embed a batch. Returns an empty array when embeddings are off or the model
 * cannot load, so callers degrade to keyword search instead of crashing.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length || !embeddingsEnabled()) return [];
  if (!embedder) {
    const provider = process.env.EMBED_PROVIDER ?? "local";
    try {
      embedder = provider === "openai" ? loadOpenAI() : await loadLocal();
    } catch (err) {
      if (!warned) {
        warned = true;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[jarvis] embeddings unavailable (${message}); keyword search only.`);
      }
      return [];
    }
  }
  // Long bodies get truncated: the model has a 256-token window and the tail of
  // a forwarded email thread is rarely what you are searching for.
  return embedder(texts.map((t) => t.slice(0, 2000)));
}

export async function embedOne(text: string): Promise<number[] | null> {
  const [vector] = await embed([text]);
  return vector ?? null;
}

/** pgvector's text input format. */
export function toVector(values: number[]): string {
  return `[${values.join(",")}]`;
}
