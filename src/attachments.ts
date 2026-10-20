export interface SourceAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  contentId?: string;
}
export const maxAttachmentBytes = 10 * 1024 * 1024;
const storageHost = "lst-desk-attachments.718734e0a9356cec87573f40ba41d3e6.r2.cloudflarestorage.com";
export function messageAttachments(message: Record<string, unknown>): SourceAttachment[] {
  if (!Array.isArray(message.emailAttachments)) return [];
  return message.emailAttachments.slice(0, 20).flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const a = value as Record<string, unknown>;
    if (typeof a.url !== "string" || !a.url || typeof a.size !== "number" || !Number.isSafeInteger(a.size) || a.size < 0) return [];
    return [{ id: `attachment-${index + 1}`, name: typeof a.name === "string" ? a.name.slice(0, 255) : "Attachment",
      mimeType: typeof a.contentType === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.contentType) ? a.contentType.toLowerCase() : "application/octet-stream",
      size: a.size, contentId: typeof a.contentId === "string" ? a.contentId.slice(0, 255) : undefined }];
  });
}
export async function retrieveAttachment(message: Record<string, unknown>, attachmentId: string, request: typeof fetch = fetch) {
  const attachment = messageAttachments(message).find(a => a.id === attachmentId);
  if (!attachment) throw new Error("Attachment not found");
  if (attachment.size > maxAttachmentBytes) throw new Error("Attachment exceeds 10 MiB limit");
  const index = Number(attachment.id.slice("attachment-".length)) - 1;
  const source = (message.emailAttachments as Record<string, unknown>[])[index];
  const signal = AbortSignal.timeout(30_000);
  try {
    const resolved = await request(`https://hd-api.lowstresstrading.com/get-presigned-url/${encodeURIComponent(String(source.url))}?v=1`, { redirect: "manual", signal });
    if (resolved.status !== 302 && resolved.status !== 307) throw new Error();
    const target = new URL(resolved.headers.get("location") ?? "");
    if (target.protocol !== "https:" || target.hostname !== storageHost || target.port || target.username || target.password) throw new Error();
    const response = await request(target, { redirect: "error", signal });
    if (!response.ok || !response.body) throw new Error();
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (mime !== attachment.mimeType) throw new Error();
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > maxAttachmentBytes)) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxAttachmentBytes) throw new Error();
      chunks.push(chunk);
    }
    if (size !== attachment.size) throw new Error();
    const data = Buffer.concat(chunks);
    if (mime === "image/png" && !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error();
    if (mime === "image/jpeg" && !(data[0] === 255 && data[1] === 216 && data[2] === 255)) throw new Error();
    if (mime === "application/pdf" && data.subarray(0, 5).toString() !== "%PDF-") throw new Error();
    return { attachment, data };
  } catch { throw new Error("HelpDesk attachment retrieval failed"); }
}
