import { COMPANION_LIMITS, PROVIDER_KEY_HEADER, TRANSCRIPTION_ENDPOINT, TRANSCRIPTION_MEDIA } from '../companion/contracts';
import type { RequestProvider, SttProviderConfig, TranscriptionMetadata, TranscriptionResponse } from '../companion/contracts';
import { exact, fail, isId, isInteger, isText, newId, parseRemoteError, requireTrue } from '../companion/core';
import { credentialBinding, trustedOrigin, validateCredentials, validateProvider } from '../settings/transport';
import type { TrustedBackend } from '../settings/transport';

export type AudioClip = { bytes:Uint8Array; filename:string; mimeType:string; durationMs:number };
export type TranscriptionSender = (url:string,options:{method:string;redirect:'error';credentials:'omit';signal:AbortSignal;headers:Record<string,string>;body:ArrayBuffer})=>Promise<{ok:boolean;json():Promise<unknown>}>;
export function validateAudioClip(clip:AudioClip):void {
  requireTrue(clip.bytes.byteLength>0);requireTrue(clip.bytes.byteLength<=COMPANION_LIMITS.maxAudioBytes,'PAYLOAD_TOO_LARGE');
  requireTrue(isInteger(clip.durationMs,1,COMPANION_LIMITS.maxAudioDurationMs));
  requireTrue(/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(clip.filename));
  requireTrue(!/[\r\n\0]/.test(clip.mimeType),'UNSUPPORTED_MEDIA_TYPE');
  const mime=clip.mimeType.split(';')[0].trim().toLowerCase();const extension=clip.filename.split('.').at(-1)?.toLowerCase();
  requireTrue(TRANSCRIPTION_MEDIA.some(media=>media.mimeType===mime&&(media.extensions as readonly string[]).includes(extension??'')),'UNSUPPORTED_MEDIA_TYPE');
}
/** 跨 RN/Web 的二进制 multipart 编码，恰好两个 part；不会把本地 URI 或 Key 放入正文。 */
export function encodeTranscription(clip:AudioClip,metadata:TranscriptionMetadata,boundary=newId('jarvis_audio')):{body:ArrayBuffer;contentType:string} {
  validateAudioClip(clip);exact(metadata,['schemaVersion','requestId','provider','credentialBinding','durationMs','language']);
  requireTrue(metadata.schemaVersion===1&&isId(metadata.requestId)&&metadata.durationMs===clip.durationMs,'INVALID_SCHEMA');
  requireTrue(metadata.language===null||/^[a-z]{2}$/.test(metadata.language),'INVALID_SCHEMA');validateProvider(metadata.provider);requireTrue(metadata.provider.purpose==='stt','INVALID_SCHEMA');
  exact(metadata.credentialBinding,['credentialId','credentialRevision']);requireTrue(isId(metadata.credentialBinding.credentialId)&&isInteger(metadata.credentialBinding.credentialRevision,1),'INVALID_SCHEMA');
  requireTrue(/^[A-Za-z0-9_-]{1,70}$/.test(boundary));
  const utf8=new TextEncoder();const metadataJson=JSON.stringify(metadata);requireTrue(utf8.encode(metadataJson).byteLength<=COMPANION_LIMITS.maxTranscriptionMetadataBytes,'PAYLOAD_TOO_LARGE');
  const first=utf8.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${clip.filename}"\r\nContent-Type: ${clip.mimeType}\r\n\r\n`);
  const last=utf8.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadataJson}\r\n--${boundary}--\r\n`);
  const bytes=new Uint8Array(first.length+clip.bytes.length+last.length);requireTrue(bytes.byteLength<=COMPANION_LIMITS.maxMultipartBytes,'PAYLOAD_TOO_LARGE');
  bytes.set(first);bytes.set(clip.bytes,first.length);bytes.set(last,first.length+clip.bytes.length);
  return{body:bytes.buffer,contentType:`multipart/form-data; boundary=${boundary}`};
}
export function validateTranscriptionResponse(value:unknown,requestId:string):TranscriptionResponse {
  const result=exact(value,['schemaVersion','requestId','text']);requireTrue(result.schemaVersion===1&&result.requestId===requestId&&isText(result.text,COMPANION_LIMITS.maxTranscriptionChars),'INVALID_SCHEMA');
  return{schemaVersion:1,requestId,text:result.text};
}
export async function transcribeAudio(backend:TrustedBackend,provider:RequestProvider<SttProviderConfig>,clip:AudioClip,signal?:AbortSignal,send:TranscriptionSender=fetch):Promise<string> {
  const origin=trustedOrigin(backend);validateCredentials(provider.credentials);validateProvider(provider.provider);
  requireTrue(provider.provider.purpose==='stt','INVALID_SCHEMA');
  const requestId=newId('stt');const encoded=encodeTranscription(clip,{schemaVersion:1,requestId,provider:provider.provider,credentialBinding:credentialBinding(provider.credentials),durationMs:clip.durationMs,language:'zh'});
  const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},COMPANION_LIMITS.transcriptionTimeoutMs);
  try {
    if(controller.signal.aborted)fail('CANCELLED');
    const response=await send(origin+TRANSCRIPTION_ENDPOINT,{method:'POST',redirect:'error',credentials:'omit',signal:controller.signal,headers:{'Content-Type':encoded.contentType,[PROVIDER_KEY_HEADER]:provider.credentials.apiKey},body:encoded.body});
    const json=await response.json();if(controller.signal.aborted)fail(timedOut?'TIMEOUT':'CANCELLED');
    if(!response.ok)fail(parseRemoteError(json).code);
    return validateTranscriptionResponse(json,requestId).text;
  } catch(error) {
    if(controller.signal.aborted)fail(timedOut?'TIMEOUT':'CANCELLED');
    if(error instanceof Error&&error.name==='CompanionFailure')throw error;
    return fail('NETWORK_UNAVAILABLE');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
