import { PROVIDER_BASE_URLS, PROVIDER_KEY_HEADER } from '../companion/contracts';
import type { AssistantOptionsExtension, AssistantWireExtension, CredentialBinding, ProviderConfig, RequestCredentials, RequestProvider } from '../companion/contracts';
import { exact, fail, isId, isInteger, isText, parseRemoteError, requireTrue, safeError } from '../companion/core';

export type TrustedBackend = { origin: string; confirmed: boolean };
export function trustedOrigin(backend: TrustedBackend): string {
  let url: URL;
  try { url=new URL(backend.origin); } catch { fail('INSECURE_TRANSPORT'); }
  requireTrue(url.protocol==='https:' && url.origin===backend.origin && !url.username && !url.password && !url.search && !url.hash,'INSECURE_TRANSPORT');
  const host=url.hostname.toLowerCase();
  requireTrue(!['localhost','0.0.0.0','[::1]'].includes(host) && !host.endsWith('.localhost') && !host.endsWith('.local') && !/^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host),'INSECURE_TRANSPORT');
  requireTrue(backend.confirmed,'CONSENT_REQUIRED');return url.origin;
}
export function validateProvider(provider: ProviderConfig): void {
  requireTrue(isText(provider.model,128),'INVALID_SCHEMA');
  if(provider.purpose==='chat') {
    exact(provider,['purpose','preset','baseUrl','model']);requireTrue(provider.preset==='deepseek' && provider.baseUrl===PROVIDER_BASE_URLS.deepseek,'PROVIDER_NOT_ALLOWED');
  } else if(provider.purpose==='stt') {
    exact(provider,['purpose','preset','baseUrl','model']);requireTrue(provider.preset==='openai' && provider.baseUrl===PROVIDER_BASE_URLS.openai,'PROVIDER_NOT_ALLOWED');
  } else if(provider.purpose==='vision') {
    exact(provider,['purpose','preset','baseUrl','model','thinking','credentialSource']);
    requireTrue(provider.thinking==='disabled','INVALID_SCHEMA');
    requireTrue(provider.preset==='deepseek' ? provider.model==='deepseek-flash' && provider.baseUrl===PROVIDER_BASE_URLS.deepseek && provider.credentialSource==='chat' : provider.preset==='qwen' && provider.model==='qwen3-vl-plus' && provider.credentialSource==='vision' && [PROVIDER_BASE_URLS.qwenCn,PROVIDER_BASE_URLS.qwenIntl,PROVIDER_BASE_URLS.qwenUs].includes(provider.baseUrl),'PROVIDER_NOT_ALLOWED');
  } else fail('INVALID_SCHEMA');
}
export function validateCredentials(credentials: RequestCredentials): void {
  exact(credentials,['credentialId','credentialRevision','apiKey']);
  requireTrue(isId(credentials.credentialId) && isInteger(credentials.credentialRevision,1),'INVALID_SCHEMA');
  requireTrue(typeof credentials.apiKey==='string' && credentials.apiKey.trim().length>0 && credentials.apiKey.length<=4096 && !/[\r\n\0]/.test(credentials.apiKey),'AUTH_REQUIRED');
}
export function credentialBinding(credentials: RequestCredentials): CredentialBinding {
  return {credentialId:credentials.credentialId,credentialRevision:credentials.credentialRevision};
}
/** 返回 body/headers 分离的兼容扩展；集成者仍调用原 askAssistant 三参数接口。 */
export function assistantWire(backend: TrustedBackend, options: AssistantOptionsExtension = {}): { body: AssistantWireExtension; headers: Record<string,string> } {
  const body: AssistantWireExtension={}; const headers:Record<string,string>={};
  if(options.memory){body.schemaVersion=1;body.memory=options.memory;}
  if(options.requestProvider) {
    trustedOrigin(backend);validateProvider(options.requestProvider.provider);validateCredentials(options.requestProvider.credentials);
    body.schemaVersion=1;body.provider=options.requestProvider.provider;body.credentialBinding=credentialBinding(options.requestProvider.credentials);
    headers[PROVIDER_KEY_HEADER]=options.requestProvider.credentials.apiKey;
  }
  return {body,headers};
}
export type ProviderCheckResponse = { schemaVersion:1; ok:true; scope:'credentials_only' };
export function providerCheckFailureNotice(cause:unknown):{text:string;error:boolean} {
  const failure=safeError(cause,'NETWORK_UNAVAILABLE');
  if(failure.code==='UNSUPPORTED')return {text:'该供应商不支持非付费连接检测，尚未验证凭据；这不代表实际功能不可用，也不会自动发起付费调用。',error:false};
  return {text:failure.message,error:true};
}
export type ProviderCheckSender = (url:string,options:{method:'POST';redirect:'error';credentials:'omit';signal:AbortSignal;headers:Record<string,string>;body:string})=>Promise<{ok:boolean;json():Promise<unknown>}>;
export async function checkProvider(backend:TrustedBackend,request:RequestProvider,signal?:AbortSignal,send:ProviderCheckSender=fetch):Promise<ProviderCheckResponse> {
  const origin=trustedOrigin(backend);validateProvider(request.provider);validateCredentials(request.credentials);
  const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)controller.abort();let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},12000);
  try {
    if(controller.signal.aborted)fail('CANCELLED');
    const response=await send(origin+'/v1/providers/check',{method:'POST',redirect:'error',credentials:'omit',signal:controller.signal,headers:{'Content-Type':'application/json',[PROVIDER_KEY_HEADER]:request.credentials.apiKey},body:JSON.stringify({schemaVersion:1,provider:request.provider,credentialBinding:credentialBinding(request.credentials)})});
    const json=await response.json();
    if(!response.ok)fail(parseRemoteError(json).code);
    const value=exact(json,['schemaVersion','ok','scope']);
    requireTrue(value.schemaVersion===1 && value.ok===true && value.scope==='credentials_only','INVALID_SCHEMA');
    if(controller.signal.aborted)fail(timedOut?'TIMEOUT':'CANCELLED');
    return {schemaVersion:1,ok:true,scope:'credentials_only'};
  } catch(error) {
    if(controller.signal.aborted)fail(timedOut?'TIMEOUT':'CANCELLED');
    if(error instanceof Error && error.name==='CompanionFailure')throw error;
    return fail('NETWORK_UNAVAILABLE');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
