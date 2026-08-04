import zlib from "node:zlib";

/**
 * App-layer HTTP compression for pi-web route handlers.
 *
 * The gateway in front of pi-web has compression disabled, so the app is the
 * single source of Content-Encoding. Content negotiation prefers zstd
 * (best speed/ratio for dynamic content, supported in Chrome 123+/FF 126+/
 * Safari 26.3+), falling back to brotli (JSON only) then gzip (universal).
 * Clients that advertise none of these receive an identity response.
 *
 * Two flavors:
 *  - `compressedJson` / `compressedResponse`: whole-body (buffer) compression
 *    for request/response JSON and HTML. Tiny payloads skip compression.
 *  - `pipeCompressed` / `createCompressTransform`: streaming compression with a
 *    flush after every chunk, so SSE / streamed responses stay live.
 *    (zstd + gzip only; brotli streaming flush is skipped.)
 */

/** Minimum body size worth compressing — below this, overhead exceeds savings. */
const MIN_COMPRESS_SIZE = 1024;

const ZSTD_LEVEL = 3; // zlib default; good speed/ratio balance
const BROTLI_QUALITY = 4; // fast end of the range, suitable for dynamic responses
const GZIP_LEVEL = 6; // zlib default

export type CompressEncoding = "zstd" | "br" | "gzip";

/**
 * Choose an encoding from the client's Accept-Encoding header.
 * Preference order: zstd > br > gzip. Respects q=0 (explicitly disabled) and
 * the `*` wildcard. Returns null when no supported encoding is acceptable.
 */
export function pickEncoding(acceptEncoding: string | null): CompressEncoding | null {
  if (!acceptEncoding) return null;

  const entries = acceptEncoding
    .split(",")
    .map((part) => {
      const [coding, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? parseFloat(qParam.trim().slice(2)) : 1;
      return { coding: coding.trim().toLowerCase(), q: Number.isNaN(q) ? 1 : q };
    })
    .filter((e) => e.coding !== "" && e.q > 0);

  const has = (c: string) => entries.some((e) => e.coding === c || e.coding === "*");
  if (has("zstd")) return "zstd";
  if (has("br")) return "br";
  if (has("gzip")) return "gzip";
  // `identity`-only or unsupported → no compression.
  return null;
}

function compressBuffer(buf: Buffer, encoding: CompressEncoding): Buffer {
  switch (encoding) {
    case "zstd":
      return zlib.zstdCompressSync(buf, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
      });
    case "br":
      return zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } });
    case "gzip":
      return zlib.gzipSync(buf, { level: GZIP_LEVEL });
  }
}

/** Append `Accept-Encoding` to the Vary header (deduped). */
function appendVary(headers: Headers): void {
  if (headers.get("Vary") === "*") return;
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", "Accept-Encoding");
    return;
  }
  const tokens = existing.split(",").map((t) => t.trim().toLowerCase());
  if (!tokens.includes("accept-encoding")) {
    headers.set("Vary", `${existing}, Accept-Encoding`);
  }
}

/**
 * Compress a whole-body response (string or Buffer) with content negotiation.
 * Sets Content-Encoding / Vary / Content-Length when compressing; falls back to
 * an identity response (still with Content-Length) when the client accepts none
 * of the supported encodings or compression would not help.
 */
export function compressedResponse(
  req: Request,
  body: string | Buffer,
  init: ResponseInit = {},
): Response {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const encoding = buf.length >= MIN_COMPRESS_SIZE ? pickEncoding(req.headers.get("accept-encoding")) : null;

  if (encoding) {
    const compressed = compressBuffer(buf, encoding);
    if (compressed.length < buf.length) {
      headers.set("Content-Encoding", encoding);
      headers.set("Content-Length", String(compressed.length));
      appendVary(headers);
      return new Response(toResponseBody(compressed), { status: init.status, statusText: init.statusText, headers });
    }
  }

  headers.set("Content-Length", String(buf.length));
  appendVary(headers);
  return new Response(toResponseBody(buf), { status: init.status, statusText: init.statusText, headers });
}

/** Zero-copy view of a Node Buffer as a Uint8Array acceptable as a Response body. */
function toResponseBody(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
}

/** Drop-in for `Response.json` / `NextResponse.json` with negotiated compression. */
export function compressedJson(req: Request, body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return compressedResponse(req, JSON.stringify(body), { ...init, headers });
}

/**
 * A TransformStream that compresses each chunk and flushes immediately, so the
 * decoder can consume every chunk as soon as it is produced (keeps SSE live).
 * zstd uses an explicit block flush; gzip uses Z_SYNC_FLUSH.
 */
export function createCompressTransform(encoding: "zstd" | "gzip"): TransformStream<Uint8Array, Uint8Array> {
  const compressor =
    encoding === "zstd"
      ? zlib.createZstdCompress({
          params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
        })
      : zlib.createGzip({ level: GZIP_LEVEL });

  const pending: Buffer[] = [];
  compressor.on("data", (c: Buffer) => pending.push(c));

  const flushKind = encoding === "gzip" ? zlib.constants.Z_SYNC_FLUSH : undefined;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      return new Promise<void>((resolve) => {
        compressor.write(Buffer.from(chunk));
        const done = () => {
          const out = pending.splice(0);
          if (out.length) controller.enqueue(Buffer.concat(out));
          resolve();
        };
        if (flushKind !== undefined) {
          compressor.flush(flushKind, done);
        } else {
          compressor.flush(done);
        }
      });
    },
    flush(controller) {
      return new Promise<void>((resolve) => {
        compressor.on("end", () => {
          const out = pending.splice(0);
          if (out.length) controller.enqueue(Buffer.concat(out));
          resolve();
        });
        compressor.end();
      });
    },
  });
}

/**
 * Choose a streaming encoding (zstd > gzip) and, if the client accepts one, wrap
 * `stream` so its output is compressed with a per-chunk flush. Returns the
 * (possibly transformed) stream and the chosen encoding (null = identity).
 */
export function pipeCompressed(
  req: Request,
  stream: ReadableStream<Uint8Array>,
): { stream: ReadableStream<Uint8Array>; encoding: CompressEncoding | null } {
  const encoding = pickEncoding(req.headers.get("accept-encoding"));
  if (encoding === "zstd" || encoding === "gzip") {
    return { stream: stream.pipeThrough(createCompressTransform(encoding)), encoding };
  }
  // br is not offered for streaming; a br-only client (rare) gets identity.
  return { stream, encoding: null };
}

/**
 * Build an SSE `Response` whose stream is compressed (per-chunk flush) when the
 * client accepts zstd/gzip, else passed through uncompressed. Sets
 * `X-Accel-Buffering: no` (nginx) and `no-transform` so intermediaries neither
 * buffer nor re-encode the event stream.
 */
export function compressedSse(req: Request, stream: ReadableStream<Uint8Array>): Response {
  const { stream: body, encoding } = pipeCompressed(req, stream);
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (encoding) {
    headers["Content-Encoding"] = encoding;
    headers["Vary"] = "Accept-Encoding";
  }
  return new Response(body, { headers });
}
