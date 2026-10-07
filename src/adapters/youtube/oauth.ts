import type { ChannelConfig } from '../../core/config.js';

type GoogleTokenResponse={access_token?:string;expires_in?:number;refresh_token?:string;error?:string;error_description?:string};
const tokens=new Map<string,{value:string;expiresAt:number}>();

export const youtubeScope='https://www.googleapis.com/auth/youtube.force-ssl';

async function tokenRequest(body:URLSearchParams):Promise<GoogleTokenResponse>{
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(15_000)});
  const result=await response.json() as GoogleTokenResponse;
  if(!response.ok||!result.access_token)throw new Error(`YouTube OAuth failed: ${result.error_description??result.error??`HTTP ${response.status}`}`);
  return result;
}

export function youtubeAuthorizationUrl(clientId:string,redirectUri:string,state:string):string{
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [key,value] of Object.entries({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:youtubeScope,access_type:'offline',prompt:'consent',include_granted_scopes:'true',state}))url.searchParams.set(key,value);
  return url.toString();
}

export async function exchangeYoutubeCode(clientId:string,clientSecret:string,code:string,redirectUri:string):Promise<{accessToken:string;refreshToken?:string;expiresIn:number}>{
  const result=await tokenRequest(new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,redirect_uri:redirectUri,grant_type:'authorization_code'}));
  return {accessToken:result.access_token!,refreshToken:result.refresh_token,expiresIn:result.expires_in??3600};
}

export async function youtubeAccessToken(cfg:ChannelConfig):Promise<string>{
  const cached=tokens.get(cfg.id);if(cached&&cached.expiresAt>Date.now()+60_000)return cached.value;
  const {oauthClientId,oauthClientSecret,refreshToken,accessToken}=cfg.credentials;
  if(oauthClientId&&oauthClientSecret&&refreshToken){
    const result=await tokenRequest(new URLSearchParams({client_id:oauthClientId,client_secret:oauthClientSecret,refresh_token:refreshToken,grant_type:'refresh_token'}));
    tokens.set(cfg.id,{value:result.access_token!,expiresAt:Date.now()+(result.expires_in??3600)*1000});
    return result.access_token!;
  }
  if(accessToken)return accessToken;
  throw new Error('Connect the YouTube channel with OAuth 2.0');
}

export function rememberYoutubeAccessToken(channelId:string,value:string,expiresIn:number):void{tokens.set(channelId,{value,expiresAt:Date.now()+expiresIn*1000});}
