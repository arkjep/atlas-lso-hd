import test from "node:test";
import assert from "node:assert/strict";
import { messageAttachments, retrieveAttachment, maxAttachmentBytes } from "../dist/attachments.js";
const png = Buffer.from([137,80,78,71,13,10,26,10]);
const message = { emailAttachments: [{ name: "image.png", contentType: "image/png", size: 8, url: "private/storage/key", originalUrl: "https://example.invalid/secret", contentId: "cid" }] };
const host = "lst-desk-attachments.718734e0a9356cec87573f40ba41d3e6.r2.cloudflarestorage.com";
function requests(options = {}) {
 const calls = [];
 const request = async (url, init) => {
  calls.push({ url: String(url), init });
  if (calls.length === 1) return new Response(null, { status: options.status ?? 302, headers: { location: options.target ?? `https://${host}/object?signature=private` } });
  return new Response(options.bytes ?? png, { status: options.storageStatus ?? 200, headers: { "content-type": options.mime ?? "image/png", ...(options.length ? { "content-length": options.length } : {}) } });
 };
 return { request, calls };
}
test("descriptors preserve metadata without storage or signed URLs", () => {
 const [a] = messageAttachments(message);
 assert.deepEqual(a, { id: "attachment-1", name: "image.png", mimeType: "image/png", size: 8, contentId: "cid" });
 assert.doesNotMatch(JSON.stringify(a), /url|signature|private/);
 assert.deepEqual(messageAttachments({ emailAttachments: [null, { url: "x", size: -1 }] }), []);
});
test("downloads through presign route without forwarding bearer, with bounded redirects", async () => {
 const { request, calls } = requests(); const result = await retrieveAttachment(message, "attachment-1", request);
 assert.deepEqual(result.data, png); assert.equal(calls.length, 2);
 assert.match(calls[0].url, /get-presigned-url\/private%2Fstorage%2Fkey\?v=1$/);
 assert.equal(calls[0].init.redirect, "manual"); assert.equal(calls[1].init.redirect, "error");
 for (const c of calls) { assert.equal(c.init.headers, undefined); assert.ok(c.init.signal); }
 assert.doesNotMatch(JSON.stringify(result.attachment), /signature|private/);
});
test("rejects arbitrary redirects, protocol, credentials, ports and additional redirects", async () => {
 for (const target of ["http://"+host+"/x", "https://evil.invalid/x", "https://"+host+".evil.invalid/x", "https://user:pass@"+host+"/x", "https://"+host+":444/x"]) {
  const {request,calls}=requests({target}); await assert.rejects(retrieveAttachment(message,"attachment-1",request), /retrieval failed/); assert.equal(calls.length,1);
 }
 for (const options of [{status:404},{storageStatus:401},{storageStatus:302},{mime:"text/html"},{bytes:Buffer.alloc(8)},{bytes:png.subarray(0,4)},{length:String(maxAttachmentBytes+1)},{bytes:Buffer.alloc(maxAttachmentBytes+1)}]) {
  await assert.rejects(retrieveAttachment(message,"attachment-1",requests(options).request), /retrieval failed/);
 }
});
test("rejects unknown IDs and oversized metadata before requesting bytes", async () => {
 const {request,calls}=requests(); await assert.rejects(retrieveAttachment(message,"attachment-2",request),/not found/);
 await assert.rejects(retrieveAttachment({emailAttachments:[{...message.emailAttachments[0],size:maxAttachmentBytes+1}]},"attachment-1",request),/limit/); assert.equal(calls.length,0);
});
test("network errors do not disclose signed URLs", async () => {
 await assert.rejects(retrieveAttachment(message,"attachment-1",async()=>{throw Error("https://private?signature=secret");}),error=>error.message==="HelpDesk attachment retrieval failed");
});
test("provider retains attachment-only messages and authorizes message membership with fresh conversation data", async () => {
 process.env.LSO_HD_ACCESS_TOKEN="test-only";
 const original=globalThis.fetch; let requestsCount=0;
 globalThis.fetch=async(url,init)=>{
  requestsCount++; const u=new URL(url);
  assert.equal(u.origin,"https://hd-api.lowstresstrading.com"); assert.equal(u.pathname,"/trpc/conversations.getConversation");
  const input=JSON.parse(u.searchParams.get("input"));assert.equal(input.conversationId,"conversation-a");assert.equal(input.workspaceId,"LST");
  return new Response(JSON.stringify({result:{data:{conversation:{_id:"conversation-a"},contact:{},messages:[{_id:"message-a",type:"EMAIL",...message},{_id:"note",type:"NOTE",...message}]}}}));
 };
 try {
  const {provider}=await import("../dist/index.js");
  const ref={provider:provider.id,externalObjectType:"conversation",externalObjectId:"conversation-a",metadata:{workspaceId:"LST"}};
  const thread=await provider.fetchThread({ref});assert.equal(thread.messages.length,1);assert.equal(thread.messages[0].text,"");assert.equal(thread.messages[0].attachments.length,1);
  await assert.rejects(provider.fetchAttachment({ref,messageId:"other-conversation-message",attachmentId:"attachment-1"}),/not found in conversation/);
  await assert.rejects(provider.fetchAttachment({ref,messageId:"note",attachmentId:"attachment-1"}),/not found in conversation/);
  await assert.rejects(provider.fetchAttachment({ref:{...ref,provider:"other"},messageId:"message-a",attachmentId:"attachment-1"}),/Invalid/);
  assert.equal(requestsCount,3);
 } finally { globalThis.fetch=original; }
});
